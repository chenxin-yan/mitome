import { Effect, Schema } from "effect";
import { AiError, Tool as AiTool, Toolkit } from "effect/unstable/ai";
import { DefinitionError, setToolResultValidator } from "@mitome/core";
import type { Plugin, PluginHooks } from "@mitome/core";
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";

type EffectSchema<Output> = Schema.Codec<Output, unknown, never, never>;

export type StandardSchema<Input = unknown, Output = Input> = StandardSchemaV1<Input, Output>;
export type InputSchema<Input = unknown> =
  | (StandardSchemaV1<unknown, Input> & StandardJSONSchemaV1<unknown, Input>)
  | EffectSchema<Input>;
export type OutputSchema<Output = unknown> =
  | StandardSchemaV1<unknown, Output>
  | EffectSchema<Output>;

export interface HookContext {
  readonly signal: AbortSignal;
}

export interface PluginHooksDefinition {
  readonly sessionStart?: (context: HookContext) => Promise<void>;
  readonly sessionEnd?: (context: HookContext) => Promise<void>;
  readonly turnStart?: (text: string, context: HookContext) => Promise<void>;
  readonly turnEnd?: (text: string, context: HookContext) => Promise<void>;
  readonly stepStart?: (prompt: unknown, context: HookContext) => Promise<void>;
  readonly stepEnd?: (prompt: unknown, context: HookContext) => Promise<void>;
  readonly preStep?: (prompt: unknown, context: HookContext) => Promise<unknown>;
  readonly preTool?: (
    context: { readonly name: string; readonly params: unknown } & HookContext,
  ) => Promise<void | { readonly reason: string }>;
  readonly postTool?: (
    context: {
      readonly name: string;
      readonly params: unknown;
      readonly result: unknown;
      readonly isFailure: boolean;
    } & HookContext,
  ) => Promise<unknown>;
}

export interface Tool<Input = unknown, Output = unknown> {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: InputSchema<Input>;
  readonly outputSchema: OutputSchema<Output>;
  readonly handler: (input: Input, context: HookContext) => Promise<Output>;
}

export const tool = <Input, Output>(definition: Tool<Input, Output>): Tool<Input, Output> =>
  definition;

type StandardInput<Input> = StandardSchemaV1.Props<unknown, Input> &
  StandardJSONSchemaV1.Props<unknown, Input>;

const standardInput = <Input>(schema: InputSchema<Input>): StandardInput<Input> => {
  if (Schema.isSchema(schema)) {
    return Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema))["~standard"];
  }
  const standard = schema["~standard"];
  if (!("validate" in standard) || !("jsonSchema" in standard)) {
    throw new DefinitionError({
      message: "Tool input schema must provide validation and JSON Schema",
    });
  }
  return standard;
};

const standardOutput = <Output>(
  schema: OutputSchema<Output>,
): StandardSchemaV1.Props<unknown, Output> => {
  if (Schema.isSchema(schema)) {
    return Schema.toStandardSchemaV1(schema)["~standard"];
  }
  const standard = schema["~standard"];
  if (!("validate" in standard)) {
    throw new DefinitionError({ message: "Tool output schema must provide validation" });
  }
  return standard;
};

const validate = async <Output>(
  standard: StandardSchemaV1.Props<unknown, Output>,
  value: unknown,
): Promise<Output> => {
  const result = await standard.validate(value);
  if (result.issues) throw new Error(result.issues[0]?.message ?? "Schema validation failed");
  return result.value;
};

// Core Hooks use an unknown error channel so TurnError retains the original cause.
const promiseHook = <A>(callback: (signal: HookContext["signal"]) => Promise<A>) =>
  // @effect-diagnostics-next-line unknownInEffectCatch:off
  Effect.tryPromise({
    try: callback,
    catch: (cause) => cause,
  });

const adaptHooks = (hooks: PluginHooksDefinition | undefined): PluginHooks | undefined => {
  if (hooks === undefined) return undefined;
  const adapted: { -readonly [Key in keyof PluginHooks]?: PluginHooks[Key] } = {};
  if (hooks.sessionStart)
    adapted.sessionStart = promiseHook((signal) => hooks.sessionStart!({ signal }));
  if (hooks.sessionEnd) adapted.sessionEnd = promiseHook((signal) => hooks.sessionEnd!({ signal }));
  if (hooks.turnStart)
    adapted.turnStart = (text) => promiseHook((signal) => hooks.turnStart!(text, { signal }));
  if (hooks.turnEnd)
    adapted.turnEnd = (text) => promiseHook((signal) => hooks.turnEnd!(text, { signal }));
  if (hooks.stepStart)
    adapted.stepStart = (prompt) => promiseHook((signal) => hooks.stepStart!(prompt, { signal }));
  if (hooks.stepEnd)
    adapted.stepEnd = (prompt) => promiseHook((signal) => hooks.stepEnd!(prompt, { signal }));
  if (hooks.preStep)
    adapted.preStep = (prompt) =>
      promiseHook((signal) => hooks.preStep!(prompt, { signal })) as never;
  if (hooks.preTool)
    adapted.preTool = (context) => promiseHook((signal) => hooks.preTool!({ ...context, signal }));
  if (hooks.postTool)
    adapted.postTool = (context) =>
      promiseHook((signal) => hooks.postTool!({ ...context, signal }));
  return adapted;
};

export const definePlugin = (definition: {
  readonly name: string;
  readonly tools: ReadonlyArray<Tool<any, any>>;
  readonly hooks?: PluginHooksDefinition;
}): Plugin => {
  const names = new Set<string>();
  const definitions = definition.tools.map((tool) => {
    if (names.has(tool.name)) {
      throw new DefinitionError({ message: `Duplicate Tool name: ${tool.name}` });
    }
    names.add(tool.name);
    return {
      tool,
      input: standardInput(tool.inputSchema),
      output: standardOutput(tool.outputSchema),
    };
  });

  const tools = definitions.map(({ tool, input, output }) => {
    const dynamic = AiTool.dynamic(tool.name, {
      description: tool.description,
      parameters: input.jsonSchema.input({ target: "draft-2020-12" }),
      failureMode: "return",
    });
    setToolResultValidator(dynamic, (result) =>
      // @effect-diagnostics-next-line unknownInEffectCatch:off
      Effect.tryPromise({
        try: () => validate(output, result),
        catch: (cause) => cause,
      }),
    );
    return dynamic;
  });

  const hooks = adaptHooks(definition.hooks);
  return {
    name: definition.name,
    ...(hooks === undefined ? {} : { hooks }),
    toolkit: Toolkit.make(...tools),
    handlers: Object.fromEntries(
      definitions.map(({ tool, input, output }) => [
        tool.name,
        (params: unknown) =>
          Effect.tryPromise({
            try: async (signal) =>
              validate(output, await tool.handler(await validate(input, params), { signal })),
            // SDK handlers are untrusted promises; the model gets a stable failure instead.
            catch: () =>
              AiError.make({
                module: "@mitome/sdk",
                method: tool.name,
                reason: new AiError.UnknownError({ description: "SDK tool handler failed" }),
              }),
          }),
      ]),
    ),
  };
};
