import { Context, Effect, Layer, Schema } from "effect";
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

export interface HookContext<Resource = never> {
  readonly resource: Resource;
  readonly signal: AbortSignal;
}

export interface PluginHooksDefinition<Resource = never> {
  readonly sessionStart?: (context: HookContext<Resource>) => Promise<void>;
  readonly sessionEnd?: (context: HookContext<Resource>) => Promise<void>;
  readonly turnStart?: (text: string, context: HookContext<Resource>) => Promise<void>;
  readonly turnEnd?: (text: string, context: HookContext<Resource>) => Promise<void>;
  readonly stepStart?: (prompt: Prompt, context: HookContext<Resource>) => Promise<void>;
  /** Receives the prompt used by the model, including any completed pre-Step transforms. */
  readonly stepEnd?: (prompt: Prompt, context: HookContext<Resource>) => Promise<void>;
  readonly preStep?: (prompt: Prompt, context: HookContext<Resource>) => Promise<Prompt>;
  readonly preTool?: (
    context: ToolHookContext & HookContext<Resource>,
  ) => Promise<void | { readonly reason: string }>;
  readonly postTool?: (context: ToolResultHookContext & HookContext<Resource>) => Promise<unknown>;
}

export interface Tool<Input = unknown, Output = unknown, Resource = never> {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: InputSchema<Input>;
  readonly outputSchema: OutputSchema<Output>;
  readonly handler: (input: Input, context: HookContext<Resource>) => Promise<Output>;
}

export const tool = <Input, Output, Resource>(
  definition: Tool<Input, Output, Resource>,
): Tool<Input, Output, Resource> => definition;

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
const promiseHook = <A, Resource>(
  callback: (context: HookContext<Resource>) => Promise<A>,
  resource: Context.Service<Resource, Resource> | undefined,
): Effect.Effect<A, unknown, Resource> =>
  Effect.gen(function* () {
    const value =
      resource === undefined ? (undefined as Resource) : yield* Effect.service(resource);
    // @effect-diagnostics-next-line unknownInEffectCatch:off
    return yield* Effect.tryPromise({
      try: (signal) => callback({ resource: value, signal }),
      catch: (cause) => cause,
    });
  });

const adaptHooks = <Resource>(
  hooks: PluginHooksDefinition<Resource> | undefined,
  resource: Context.Service<Resource, Resource> | undefined,
): PluginHooks<Resource> | undefined => {
  if (hooks === undefined) return undefined;
  const adapted: { -readonly [Key in keyof PluginHooks<Resource>]?: PluginHooks<Resource>[Key] } =
    {};
  const sessionStart = hooks.sessionStart;
  if (sessionStart) adapted.sessionStart = promiseHook(sessionStart, resource);
  const sessionEnd = hooks.sessionEnd;
  if (sessionEnd) adapted.sessionEnd = promiseHook(sessionEnd, resource);
  const turnStart = hooks.turnStart;
  if (turnStart)
    adapted.turnStart = (text) => promiseHook((context) => turnStart(text, context), resource);
  const turnEnd = hooks.turnEnd;
  if (turnEnd)
    adapted.turnEnd = (text) => promiseHook((context) => turnEnd(text, context), resource);
  const stepStart = hooks.stepStart;
  if (stepStart)
    adapted.stepStart = (prompt) => promiseHook((context) => stepStart(prompt, context), resource);
  const stepEnd = hooks.stepEnd;
  if (stepEnd)
    adapted.stepEnd = (prompt) => promiseHook((context) => stepEnd(prompt, context), resource);
  const preStep = hooks.preStep;
  if (preStep)
    adapted.preStep = (prompt) =>
      promiseHook((context) => preStep(prompt, context), resource).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(AiPrompt.Prompt)),
      );
  const preTool = hooks.preTool;
  if (preTool)
    adapted.preTool = (context) =>
      promiseHook((resourceContext) => preTool({ ...context, ...resourceContext }), resource);
  const postTool = hooks.postTool;
  if (postTool)
    adapted.postTool = (context) =>
      promiseHook((resourceContext) => postTool({ ...context, ...resourceContext }), resource);
  return adapted;
};

export const definePlugin = <Resource = never>(definition: {
  readonly name: string;
  readonly tools: ReadonlyArray<Tool<any, unknown, Resource>>;
  readonly hooks?: PluginHooksDefinition<Resource>;
  readonly setup?: (context: Pick<HookContext<Resource>, "signal">) => Promise<Resource>;
  readonly dispose?: (resource: Resource) => Promise<void>;
}): Plugin<Resource, unknown> => {
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

  const service =
    definition.setup === undefined
      ? undefined
      : Context.Service<Resource>(`@mitome/sdk/${definition.name}`);
  const hooks = adaptHooks(definition.hooks, service);
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

  return {
    name: definition.name,
    ...(service === undefined
      ? {}
      : {
          resource: Layer.effect(
            service,
            Effect.acquireRelease(
              // @effect-diagnostics-next-line unknownInEffectCatch:off
              Effect.tryPromise({
                try: (signal) => definition.setup!({ signal }),
                catch: (cause) => cause,
              }),
              (value) =>
                definition.dispose === undefined
                  ? Effect.void
                  : // @effect-diagnostics-next-line unknownInEffectCatch:off
                    Effect.tryPromise({
                      try: () => definition.dispose!(value),
                      catch: (cause) => cause,
                    }).pipe(Effect.catch(Effect.die)),
            ),
          ),
        }),
    ...(hooks === undefined ? {} : { hooks }),
    toolkit: Toolkit.make(...tools),
    toolResultValidators,
    handlers: Object.fromEntries(
      definitions.map(({ tool, input, output }) => [
        tool.name,
        (params: unknown) => {
          const handle = (resource: Resource) =>
            // @effect-diagnostics-next-line unknownInEffectCatch:off
            Effect.tryPromise({
              try: async (signal) =>
                validate(
                  output,
                  await tool.handler(await validate(input, params), { resource, signal }),
                ),
              catch: (cause) => cause,
            }).pipe(
              Effect.tapError((cause) =>
                Effect.logWarning(`SDK Tool "${tool.name}" failed`, cause),
              ),
              // SDK handlers are untrusted promises; the model gets a stable failure instead.
              Effect.mapError(() =>
                AiError.make({
                  module: "@mitome/sdk",
                  method: tool.name,
                  reason: new AiError.UnknownError({ description: "SDK tool handler failed" }),
                }),
              ),
            );
          return service === undefined
            ? handle(undefined as Resource)
            : Effect.flatMap(Effect.service(service), handle);
        },
      ]),
    ),
  };
};
