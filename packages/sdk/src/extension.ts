import { Context, Effect, Exit, Layer, Schema } from "effect";
import { AiError, Prompt as AiPrompt, Tool as AiTool, Toolkit } from "effect/unstable/ai";
import type { Response as AiResponse } from "effect/unstable/ai";
import type {
  AnyExtension,
  Extension,
  ExtensionHooks,
  ToolContribution,
  ToolHookContext,
  ToolResultHookContext,
} from "@mitome/core";
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

export type ResponsePart = AiResponse.AnyPart;

export interface StepEndContext<Resource = never> extends HookContext<Resource> {
  readonly responseParts: ReadonlyArray<ResponsePart>;
}

export interface ToolApprovalContext {
  readonly toolCallId: string;
  readonly messages: ReadonlyArray<unknown>;
}

export interface ExtensionHooksDefinition<Resource = never> {
  readonly sessionStart?: (context: HookContext<Resource>) => Promise<void>;
  readonly sessionEnd?: (context: HookContext<Resource>) => Promise<void>;
  readonly turnStart?: (text: string, context: HookContext<Resource>) => Promise<void>;
  readonly turnEnd?: (text: string, context: HookContext<Resource>) => Promise<void>;
  readonly stepStart?: (prompt: Prompt, context: HookContext<Resource>) => Promise<void>;
  /** Receives the model prompt and emitted response parts; failed Steps provide their partial parts. */
  readonly stepEnd?: (prompt: Prompt, context: StepEndContext<Resource>) => Promise<void>;
  readonly preStep?: (prompt: Prompt, context: HookContext<Resource>) => Promise<Prompt>;
  readonly preTool?: (
    context: ToolHookContext & HookContext<Resource>,
  ) => Promise<void | { readonly reason: string }>;
  readonly postTool?: (context: ToolResultHookContext & HookContext<Resource>) => Promise<unknown>;
}

export interface Tool<
  Input = unknown,
  Output = unknown,
  Resource = never,
  Name extends string = string,
> {
  readonly name: Name;
  readonly description?: string;
  readonly inputSchema: InputSchema<Input>;
  readonly outputSchema: OutputSchema<Output>;
  readonly needsApproval?:
    | boolean
    | ((input: Input, context: ToolApprovalContext) => boolean | Promise<boolean>);
  readonly handler: (input: Input, context: HookContext<Resource>) => Promise<Output>;
}

export const tool = <Input, Output, Resource = never, const Name extends string = string>(
  definition: Tool<Input, Output, Resource, Name>,
): Tool<Input, Output, Resource, Name> => definition;

type StandardInput<Input> = StandardSchemaV1.Props<unknown, Input> &
  StandardJSONSchemaV1.Props<unknown, Input>;

const standardInput = <Input>(schema: InputSchema<Input>): StandardInput<Input> => {
  if (Schema.isSchema(schema)) {
    return Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema))["~standard"];
  }
  const standard = schema["~standard"];
  if (!("validate" in standard) || !("jsonSchema" in standard)) {
    throw new Error("Tool input schema must provide validation and JSON Schema");
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
    throw new Error("Tool output schema must provide validation");
  }
  return standard;
};

const validate = async <Output>(
  standard: StandardSchemaV1.Props<unknown, Output>,
  value: unknown,
): Promise<Output> => {
  const result = await standard.validate(value);
  if (result.issues) {
    const details = result.issues
      .map(({ message, path }) => {
        const location = path
          ?.map((part) => String(typeof part === "object" ? part.key : part))
          .join(".");
        return location ? `${location}: ${message}` : message;
      })
      .join("; ");
    throw new Error(details || "Schema validation failed");
  }
  return result.value;
};

// Promise Hooks use an unknown error channel; Core owns lifecycle-specific error mapping.
const promiseHook = Effect.fn("@mitome/sdk/promiseHook")(function* <A, Resource>(
  callback: (context: HookContext<Resource>) => Promise<A>,
  resource: Context.Service<Resource, Resource> | undefined,
) {
  const value = resource === undefined ? (undefined as Resource) : yield* Effect.service(resource);
  // @effect-diagnostics-next-line unknownInEffectCatch:off
  return yield* Effect.tryPromise({
    try: (signal) => callback({ resource: value, signal }),
    catch: (cause) => cause,
  });
});

const adaptHooks = <Resource>(
  hooks: ExtensionHooksDefinition<Resource> | undefined,
  resource: Context.Service<Resource, Resource> | undefined,
): ExtensionHooks<Resource> | undefined => {
  if (hooks === undefined) return undefined;
  const adapted: {
    -readonly [Key in keyof ExtensionHooks<Resource>]?: ExtensionHooks<Resource>[Key];
  } = {};
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
    adapted.stepEnd = (prompt, responseParts) =>
      promiseHook((context) => stepEnd(prompt, { ...context, responseParts }), resource);
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

type ToolResource<Value extends Tool<any, any, never, string>> = Value extends unknown
  ? Parameters<Value["handler"]>[1] extends HookContext<infer Resource>
    ? 0 extends 1 & Resource
      ? never
      : Resource
    : never
  : never;
type ToolResources<Tools extends ReadonlyArray<Tool<any, any, never, string>>> = ToolResource<
  Tools[number]
>;
type UnsatisfiedToolResources<
  Resource,
  Value extends Tool<any, any, never, string>,
> = Value extends unknown
  ? [ToolResource<Value>] extends [never]
    ? never
    : Resource extends ToolResource<Value>
      ? never
      : ToolResource<Value>
  : never;

type ToolContributions<Tools extends ReadonlyArray<Tool<any, any, never, string>>> = {
  readonly [Value in Tools[number] as Value["name"]]: ToolContribution<
    Parameters<Value["handler"]>[0],
    Awaited<ReturnType<Value["handler"]>>
  >;
};

export interface ExtensionDefinition<
  Resource = never,
  Tools extends ReadonlyArray<Tool<any, any, never, string>> = ReadonlyArray<
    Tool<any, any, Resource, string>
  >,
> {
  readonly name: string;
  readonly dependencies?: ReadonlyArray<AnyExtension>;
  readonly instructions?: string;
  readonly tools: Tools;
  readonly hooks?: ExtensionHooksDefinition<Resource>;
  readonly setup?: () => Promise<Resource>;
  readonly dispose?: (resource: Resource) => Promise<void>;
}

// A declared Resource without setup would hand handlers `undefined as Resource`,
// so setup is mandatory whenever anything in the Extension declares a Resource.
export function defineExtension<
  Resource = never,
  const Tools extends ReadonlyArray<Tool<any, any, never, string>> = ReadonlyArray<
    Tool<any, any, Resource, string>
  >,
>(
  definition: ExtensionDefinition<Resource, Tools> &
    ([UnsatisfiedToolResources<Resource, Tools[number]>] extends [never] ? unknown : never) &
    ([Resource | ToolResources<Tools>] extends [never]
      ? { readonly setup?: undefined; readonly dispose?: undefined }
      : {
          readonly setup: () => Promise<Resource>;
        }),
): NoInfer<Extension<Resource, unknown, ToolContributions<Tools>>>;
export function defineExtension<
  Resource = never,
  Tools extends ReadonlyArray<Tool<any, any, never, string>> = ReadonlyArray<
    Tool<any, any, never, string>
  >,
>(definition: ExtensionDefinition<Resource, Tools>): Extension<Resource, unknown> {
  if (definition.dispose !== undefined && definition.setup === undefined) {
    throw new Error(`Extension "${definition.name}" declares dispose without setup`);
  }
  const names = new Set<string>();
  const definitions =
    // The public overload proved every Tool Resource is satisfied (UnsatisfiedToolResources);
    // the impl signature erased Resource, so rehydrate it here.
    (definition.tools as unknown as ReadonlyArray<Tool<any, any, Resource, string>>).map((tool) => {
      if (names.has(tool.name)) throw new Error(`Duplicate Tool name: ${tool.name}`);
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
  const tools = definitions.map(({ tool, input }) => {
    const needsApproval = tool.needsApproval;
    return AiTool.dynamic(tool.name, {
      description: tool.description,
      parameters: input.jsonSchema.input({ target: "draft-2020-12" }),
      failureMode: "return",
      needsApproval:
        typeof needsApproval === "function"
          ? (params: unknown, context: ToolApprovalContext) =>
              // Rejections become defects, matching Core's fail-closed approval handling.
              Effect.promise(() => Promise.resolve().then(() => needsApproval(params, context)))
          : needsApproval,
    });
  });
  const toolInputValidators = Object.fromEntries(
    definitions.map(({ tool, input }) => [
      tool.name,
      (params: unknown) =>
        // @effect-diagnostics-next-line unknownInEffectCatch:off
        Effect.tryPromise({
          try: () => validate(input, params),
          catch: (cause) => cause,
        }),
    ]),
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

  const resource =
    service === undefined
      ? undefined
      : Layer.effect(
          service,
          Effect.acquireRelease(
            // @effect-diagnostics-next-line unknownInEffectCatch:off
            Effect.tryPromise({
              try: () => definition.setup!(),
              catch: (cause) => cause,
            }),
            (value, exit) => {
              if (definition.dispose === undefined) return Effect.void;
              const run = Effect.promise(() => definition.dispose!(value));
              // On failure exits a disposer defect would replace the primary
              // cause; log it instead so the original tagged error survives.
              return Exit.isFailure(exit)
                ? run.pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("Extension dispose failed", cause),
                    ),
                  )
                : run;
            },
          ),
        );

  return {
    name: definition.name,
    dependencies: definition.dependencies,
    instructions: definition.instructions,
    resource,
    hooks,
    toolkit: Toolkit.make(...tools),
    toolInputValidators,
    toolResultValidators,
    handlers: Object.fromEntries(
      definitions.map(({ tool, input, output }) => [
        tool.name,
        (params: unknown) =>
          promiseHook(
            async ({ resource, signal }) =>
              validate(
                output,
                await tool.handler(await validate(input, params), { resource, signal }),
              ),
            service,
          ).pipe(
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
}
