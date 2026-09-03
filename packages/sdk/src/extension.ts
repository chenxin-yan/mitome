import { Context, Effect, Exit, Layer, Predicate, Schema } from "effect";
import { AiError, Prompt as AiPrompt, Tool as AiTool, Toolkit } from "effect/unstable/ai";
import type { Response as AiResponse } from "effect/unstable/ai";
import type {
  Extension,
  ExtensionHooks,
  ToolContribution,
  ToolHookContext,
  ToolInputValidator,
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

export type ModelPrompt = AiPrompt.Prompt;

export interface HookContext<Resource = never> {
  readonly resource: Resource;
  readonly signal: AbortSignal;
}

export type ResponsePart = AiResponse.AnyPart;
type ToolHookResult = ToolResultHookContext["result"];
type UnvalidatedToolInput = Parameters<ToolInputValidator>[0];
type StandardInputValue = Parameters<StandardSchemaV1.Props["validate"]>[0];

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
  readonly turnStart?: (message: string, context: HookContext<Resource>) => Promise<void>;
  readonly turnEnd?: (message: string, context: HookContext<Resource>) => Promise<void>;
  readonly stepStart?: (prompt: ModelPrompt, context: HookContext<Resource>) => Promise<void>;
  /** Receives the Model Prompt and emitted response parts; failed Steps provide their partial parts. */
  readonly stepEnd?: (prompt: ModelPrompt, context: StepEndContext<Resource>) => Promise<void>;
  readonly preStep?: (prompt: ModelPrompt, context: HookContext<Resource>) => Promise<ModelPrompt>;
  readonly preTool?: (
    context: ToolHookContext & HookContext<Resource>,
  ) => Promise<void | { readonly reason: string }>;
  readonly postTool?: (
    context: ToolResultHookContext & HookContext<Resource>,
  ) => Promise<ToolHookResult>;
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

export function tool<Input, Output, Resource = never, const Name extends string = string>(
  definition: Tool<Input, Output, Resource, Name>,
): Tool<Input, Output, Resource, Name> {
  return definition;
}

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

const formatPathPart = (part: PropertyKey | StandardSchemaV1.PathSegment): string =>
  part instanceof Object ? String(part.key) : String(part);

const validate = async <Output>(
  standard: StandardSchemaV1.Props<unknown, Output>,
  value: StandardInputValue,
): Promise<Output> => {
  const result = await standard.validate(value);
  if (result.issues) {
    const details = result.issues
      .map(({ message, path }) => {
        const location = path?.map(formatPathPart).join(".");
        return location ? `${location}: ${message}` : message;
      })
      .join("; ");
    throw new Error(details || "Schema validation failed");
  }
  return result.value;
};

const ResourceService = Context.Service<any>("@mitome/sdk/resource");

// Promise Hooks use an unknown error channel; Core owns lifecycle-specific error mapping.
const promiseHook = Effect.fn("@mitome/sdk/promiseHook")(function* <A, Resource>(
  callback: (context: HookContext<Resource>) => Promise<A>,
  resource: Context.Service<Resource, Resource> | undefined,
) {
  // SAFETY: The public defineExtension overload only permits a missing Resource service when
  // neither setup nor any Hook/Tool declares a Resource, so callbacks cannot observe this value.
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
  const run = <A>(callback: (context: HookContext<Resource>) => Promise<A>) =>
    promiseHook<A, Resource>(callback, resource);
  const sessionStart = hooks.sessionStart;
  if (sessionStart) adapted.sessionStart = run(sessionStart);
  const sessionEnd = hooks.sessionEnd;
  if (sessionEnd) adapted.sessionEnd = run(sessionEnd);
  const turnStart = hooks.turnStart;
  if (turnStart) adapted.turnStart = (message) => run((context) => turnStart(message, context));
  const turnEnd = hooks.turnEnd;
  if (turnEnd) adapted.turnEnd = (message) => run((context) => turnEnd(message, context));
  const stepStart = hooks.stepStart;
  if (stepStart) adapted.stepStart = (prompt) => run((context) => stepStart(prompt, context));
  const stepEnd = hooks.stepEnd;
  if (stepEnd)
    adapted.stepEnd = (prompt, responseParts) =>
      run((context) => stepEnd(prompt, { ...context, responseParts }));
  const preStep = hooks.preStep;
  if (preStep)
    adapted.preStep = (prompt) =>
      run((context) => preStep(prompt, context)).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(AiPrompt.Prompt)),
      );
  const preTool = hooks.preTool;
  if (preTool)
    adapted.preTool = (context) =>
      run((resourceContext) => preTool({ ...context, ...resourceContext }));
  const postTool = hooks.postTool;
  if (postTool)
    adapted.postTool = (context) =>
      run((resourceContext) => postTool({ ...context, ...resourceContext }));
  return adapted;
};

type AnyTool = {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: InputSchema<any>;
  readonly outputSchema: OutputSchema<any>;
  readonly needsApproval?: Tool<any, any>["needsApproval"];
  readonly handler: (...args: never[]) => Promise<any>;
};
type ToolResource<Value extends AnyTool> = Value extends unknown
  ? Parameters<Value["handler"]>[1] extends HookContext<infer Resource>
    ? 0 extends 1 & Resource
      ? never
      : Resource
    : never
  : never;
type ToolResources<Tools extends ReadonlyArray<AnyTool>> = ToolResource<Tools[number]>;
type UnsatisfiedToolResources<Resource, Value extends AnyTool> = Value extends unknown
  ? [ToolResource<Value>] extends [never]
    ? never
    : Resource extends ToolResource<Value>
      ? never
      : ToolResource<Value>
  : never;
type ToolContributions<Tools extends ReadonlyArray<AnyTool>> = {
  readonly [Value in Tools[number] as Value["name"]]: ToolContribution<
    Parameters<Value["handler"]>[0],
    Awaited<ReturnType<Value["handler"]>>
  >;
};

export interface ExtensionDefinition<
  Resource = never,
  Tools extends ReadonlyArray<AnyTool> = ReadonlyArray<Tool<any, any, Resource, string>>,
> {
  readonly name?: string;
  readonly instructions?: string;
  readonly tools?: Tools;
  readonly hooks?: ExtensionHooksDefinition<Resource>;
  readonly setup?: () => Promise<Resource>;
  readonly dispose?: (resource: Resource) => Promise<void>;
}

// A declared Resource without setup would hand handlers `undefined as Resource`,
// so setup is mandatory whenever anything in the Extension declares a Resource.
export function defineExtension<Resource = never>(
  definition: ExtensionDefinition<Resource, readonly []> &
    ([Resource] extends [never]
      ? { readonly setup?: undefined; readonly dispose?: undefined }
      : { readonly setup: () => Promise<Resource> }),
): NoInfer<Extension<Resource, unknown, ToolContributions<readonly []>>>;
export function defineExtension<
  Resource = never,
  const Tools extends ReadonlyArray<AnyTool> = [Resource] extends [never]
    ? readonly []
    : ReadonlyArray<Tool<any, any, Resource, string>>,
>(
  definition: ExtensionDefinition<Resource, Tools> & { readonly tools: Tools } & ([
      UnsatisfiedToolResources<Resource, Tools[number]>,
    ] extends [never]
      ? unknown
      : never) &
    ([Resource | ToolResources<Tools>] extends [never]
      ? { readonly setup?: undefined; readonly dispose?: undefined }
      : { readonly setup: () => Promise<Resource> }),
): NoInfer<Extension<Resource, unknown, ToolContributions<Tools>>>;
export function defineExtension<
  Resource = never,
  Tools extends ReadonlyArray<AnyTool> = ReadonlyArray<Tool<any, any, Resource, string>>,
>(
  definition: ExtensionDefinition<Resource, Tools>,
): Extension<Resource, unknown, ToolContributions<Tools>> {
  if (definition.dispose !== undefined && definition.setup === undefined) {
    throw new Error(
      `Extension "${definition.name ?? "<anonymous>"}" declares dispose without setup`,
    );
  }
  const names = new Set<string>();
  const definitions = (definition.tools === undefined ? [] : definition.tools).map((tool) => {
    if (names.has(tool.name)) throw new Error(`Duplicate Tool name: ${tool.name}`);
    names.add(tool.name);
    return {
      tool,
      input: standardInput(tool.inputSchema),
      output: standardOutput(tool.outputSchema),
    };
  });

  const service = definition.setup === undefined ? undefined : ResourceService;
  const hooks = adaptHooks(definition.hooks, service);
  const tools = definitions.map(({ tool, input }) => {
    const needsApproval = tool.needsApproval;
    return AiTool.dynamic(tool.name, {
      description: tool.description,
      parameters: input.jsonSchema.input({ target: "draft-2020-12" }),
      failureMode: "return",
      needsApproval: Predicate.isFunction(needsApproval)
        ? (params: ToolHookContext["params"], context: ToolApprovalContext) =>
            // Rejections become defects, matching Core's fail-closed approval handling.
            Effect.promise(async () => needsApproval(params, context))
        : needsApproval,
    });
  });
  const validators = (
    pick: (definition: (typeof definitions)[number]) => StandardSchemaV1.Props<unknown, unknown>,
  ) =>
    Object.fromEntries(
      definitions.map((definition) => [
        definition.tool.name,
        (value: StandardInputValue) =>
          // @effect-diagnostics-next-line unknownInEffectCatch:off
          Effect.tryPromise({
            try: () => validate(pick(definition), value),
            catch: (cause) => cause,
          }),
      ]),
    );
  const toolInputValidators = validators(({ input }) => input);
  const toolResultValidators = validators(({ output }) => output);

  const resource =
    service === undefined
      ? undefined
      : Layer.effectContext(
          Effect.map(
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
            (value) => Context.make(service, value),
          ),
        );

  return {
    name: definition.name,
    instructions: definition.instructions,
    resource,
    hooks,
    toolkit: Toolkit.make(...tools),
    toolInputValidators,
    toolResultValidators,
    handlers: Object.fromEntries(
      definitions.map(({ tool, input, output }) => [
        tool.name,
        (params: UnvalidatedToolInput) =>
          promiseHook<any, Resource>(async (context) => {
            // SAFETY: every public Tool overload fixes this erased handler to the same input/context pair.
            const handler = tool.handler as (input: any, context: HookContext<any>) => Promise<any>;
            return validate(output, await handler(await validate(input, params), context));
          }, service).pipe(
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
