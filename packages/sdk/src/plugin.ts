import { Effect, Schema } from "effect";
import { AiError, Prompt as AiPrompt, Tool as AiTool, Toolkit } from "effect/unstable/ai";
import { DefinitionError } from "@mitome/core";
import type { Plugin, PluginHooks, ToolHookContext, ToolResultHookContext } from "@mitome/core";
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";

type EffectSchema<Output> = Schema.Codec<Output, unknown, never, never>;

export type StandardSchema<Input = unknown, Output = Input> = StandardSchemaV1<Input, Output>;
export type InputSchema<Input = unknown> =
  | (StandardSchemaV1<unknown, Input> & StandardJSONSchemaV1<unknown, Input>)
  | EffectSchema<Input>;
export type OutputSchema<Output = unknown> =
  | StandardSchemaV1<unknown, Output>
  | EffectSchema<Output>;

export type Prompt = AiPrompt.Prompt;

export interface HookContext {
  readonly signal: AbortSignal;
}

export interface PluginHooksDefinition {
  readonly sessionStart?: (context: HookContext) => Promise<void>;
  readonly sessionEnd?: (context: HookContext) => Promise<void>;
  readonly turnStart?: (text: string, context: HookContext) => Promise<void>;
  readonly turnEnd?: (text: string, context: HookContext) => Promise<void>;
  readonly stepStart?: (prompt: Prompt, context: HookContext) => Promise<void>;
  readonly stepEnd?: (prompt: Prompt, context: HookContext) => Promise<void>;
  readonly preStep?: (prompt: Prompt, context: HookContext) => Promise<Prompt>;
  readonly preTool?: (
    context: ToolHookContext & HookContext,
  ) => Promise<void | { readonly reason: string }>;
  readonly postTool?: (context: ToolResultHookContext & HookContext) => Promise<unknown>;
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

// Promise Hooks use an unknown error channel; Core owns lifecycle-specific error mapping.
const promiseHook = <A>(callback: (signal: HookContext["signal"]) => Promise<A>) =>
  // @effect-diagnostics-next-line unknownInEffectCatch:off
  Effect.tryPromise({
    try: callback,
    catch: (cause) => cause,
  });

const adaptHooks = (hooks: PluginHooksDefinition | undefined): PluginHooks | undefined => {
  if (hooks === undefined) return undefined;
  const adapted: { -readonly [Key in keyof PluginHooks]?: PluginHooks[Key] } = {};
  const sessionStart = hooks.sessionStart;
  if (sessionStart) adapted.sessionStart = promiseHook((signal) => sessionStart({ signal }));
  const sessionEnd = hooks.sessionEnd;
  if (sessionEnd) adapted.sessionEnd = promiseHook((signal) => sessionEnd({ signal }));
  const turnStart = hooks.turnStart;
  if (turnStart) adapted.turnStart = (text) => promiseHook((signal) => turnStart(text, { signal }));
  const turnEnd = hooks.turnEnd;
  if (turnEnd) adapted.turnEnd = (text) => promiseHook((signal) => turnEnd(text, { signal }));
  const stepStart = hooks.stepStart;
  if (stepStart)
    adapted.stepStart = (prompt) => promiseHook((signal) => stepStart(prompt, { signal }));
  const stepEnd = hooks.stepEnd;
  if (stepEnd) adapted.stepEnd = (prompt) => promiseHook((signal) => stepEnd(prompt, { signal }));
  const preStep = hooks.preStep;
  if (preStep)
    adapted.preStep = (prompt) =>
      promiseHook((signal) => preStep(prompt, { signal })).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(AiPrompt.Prompt)),
      );
  const preTool = hooks.preTool;
  if (preTool)
    adapted.preTool = (context) => promiseHook((signal) => preTool({ ...context, signal }));
  const postTool = hooks.postTool;
  if (postTool)
    adapted.postTool = (context) => promiseHook((signal) => postTool({ ...context, signal }));
  return adapted;
};

export const definePlugin = (definition: {
  readonly name: string;
  readonly tools: ReadonlyArray<Tool<any, unknown>>;
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

  const tools = definitions.map(({ tool, input }) =>
    AiTool.dynamic(tool.name, {
      description: tool.description,
      parameters: input.jsonSchema.input({ target: "draft-2020-12" }),
      failureMode: "return",
    }),
  );
  const toolResultValidators = Object.fromEntries(
    definitions.map(({ tool, output }) => [
      tool.name,
      (result: unknown) =>
        // @effect-diagnostics-next-line unknownInEffectCatch:off
        Effect.tryPromise({
          try: () => validate(output, result),
          catch: (cause) => cause,
        }),
    ]),
  );

  const hooks = adaptHooks(definition.hooks);
  return {
    name: definition.name,
    ...(hooks === undefined ? {} : { hooks }),
    toolkit: Toolkit.make(...tools),
    toolResultValidators,
    handlers: Object.fromEntries(
      definitions.map(({ tool, input, output }) => [
        tool.name,
        (params: unknown) =>
          // @effect-diagnostics-next-line unknownInEffectCatch:off
          Effect.tryPromise({
            try: async (signal) =>
              validate(output, await tool.handler(await validate(input, params), { signal })),
            catch: (cause) => cause,
          }).pipe(
            Effect.tapError((cause) => Effect.logWarning(`SDK Tool "${tool.name}" failed`, cause)),
            // SDK handlers are untrusted promises; the model gets a stable failure instead.
            Effect.mapError(() =>
              AiError.make({
                module: "@mitome/sdk",
                method: tool.name,
                reason: new AiError.UnknownError({ description: "SDK tool handler failed" }),
              }),
            ),
          ),
      ]),
    ),
  };
};
