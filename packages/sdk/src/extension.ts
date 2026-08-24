import { Context, Effect, Exit, Layer, Predicate, Result, Schema } from "effect";
import { AiError, Prompt as AiPrompt, Tool as AiTool, Toolkit } from "effect/unstable/ai";
import type { Response as AiResponse } from "effect/unstable/ai";
import type {
  AnyExtension,
  Extension,
  ExtensionHooks,
  ToolContribution,
  ToolHookContext,
  ToolInputValidator,
  ToolResultHookContext,
  ToolResultValidator,
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

type ServiceValue<Service> = Service extends Context.Key<any, infer Value> ? Value : never;

export interface HookContext<Resource = never, Services = never> {
  readonly resource: Resource;
  readonly signal: AbortSignal;
  readonly getService: <Service extends Context.Service.Any>(
    service: Context.Service.Identifier<Service> extends Services ? Service : never,
  ) => ServiceValue<Service>;
}

export type ResponsePart = AiResponse.AnyPart;
type ToolHookResult = ToolResultHookContext["result"];
type UnvalidatedToolInput = Parameters<ToolInputValidator>[0];
type UnvalidatedToolResult = Parameters<ToolResultValidator>[0];
type StandardInputValue = Parameters<StandardSchemaV1.Props["validate"]>[0];

export interface StepEndContext<Resource = never, Services = never> extends HookContext<
  Resource,
  Services
> {
  readonly responseParts: ReadonlyArray<ResponsePart>;
}

export interface ToolApprovalContext {
  readonly toolCallId: string;
  readonly messages: ReadonlyArray<unknown>;
}

export interface ExtensionHooksDefinition<Resource = never, Services = never> {
  readonly sessionStart?: (context: HookContext<Resource, Services>) => Promise<void>;
  readonly sessionEnd?: (context: HookContext<Resource, Services>) => Promise<void>;
  readonly turnStart?: (text: string, context: HookContext<Resource, Services>) => Promise<void>;
  readonly turnEnd?: (text: string, context: HookContext<Resource, Services>) => Promise<void>;
  readonly stepStart?: (prompt: Prompt, context: HookContext<Resource, Services>) => Promise<void>;
  /** Receives the model prompt and emitted response parts; failed Steps provide their partial parts. */
  readonly stepEnd?: (prompt: Prompt, context: StepEndContext<Resource, Services>) => Promise<void>;
  readonly preStep?: (prompt: Prompt, context: HookContext<Resource, Services>) => Promise<Prompt>;
  readonly preTool?: (
    context: ToolHookContext & HookContext<Resource, Services>,
  ) => Promise<void | { readonly reason: string }>;
  readonly postTool?: (
    context: ToolResultHookContext & HookContext<Resource, Services>,
  ) => Promise<ToolHookResult>;
}

export interface Tool<
  Input = unknown,
  Output = unknown,
  Resource = never,
  Name extends string = string,
  Dependencies extends ReadonlyArray<Context.Service.Any> = readonly [],
> {
  readonly name: Name;
  readonly description?: string;
  readonly inputSchema: InputSchema<Input>;
  readonly outputSchema: OutputSchema<Output>;
  readonly dependencies?: Dependencies;
  readonly needsApproval?:
    | boolean
    | ((input: Input, context: ToolApprovalContext) => boolean | Promise<boolean>);
  readonly handler: (
    input: Input,
    context: HookContext<Resource, Context.Service.Identifier<Dependencies[number]>>,
  ) => Promise<Output>;
}

export function tool<Input, Output, Resource = never, const Name extends string = string>(
  definition: Tool<Input, Output, Resource, Name, readonly []> & {
    readonly dependencies?: undefined;
  },
): Tool<Input, Output, Resource, Name, readonly []>;
export function tool<
  Input,
  Output,
  Resource = never,
  const Name extends string = string,
  const Dependencies extends ReadonlyArray<Context.Service.Any> = readonly [],
>(
  definition: Tool<Input, Output, Resource, Name, Dependencies> & {
    readonly dependencies: Dependencies;
  },
): Tool<Input, Output, Resource, Name, Dependencies>;
export function tool(definition: AnyTool): AnyTool {
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

const PropertyKey = Schema.Union([Schema.String, Schema.Number, Schema.Symbol]);
const PathSegment = Schema.Struct({ key: PropertyKey });
const PathPart = Schema.Union([PropertyKey, PathSegment]);
const isPathSegment = Schema.is(PathSegment);

const formatPathPart = (part: PropertyKey | StandardSchemaV1.PathSegment): string =>
  Result.match(Schema.decodeResult(PathPart)(part), {
    onFailure: () => "<invalid path>",
    onSuccess: (value) => String(isPathSegment(value) ? value.key : value),
  });

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

// Promise Hooks use an unknown error channel; Core owns lifecycle-specific error mapping.
const promiseHook = Effect.fn("@mitome/sdk/promiseHook")(function* <A, Resource, Services>(
  callback: (context: HookContext<Resource, Services>) => Promise<A>,
  resource: Context.Service<Resource, Resource> | undefined,
) {
  // SAFETY: The public defineExtension overload only permits a missing Resource service when
  // neither setup nor any Hook/Tool declares a Resource, so callbacks cannot observe this value.
  const value = resource === undefined ? (undefined as Resource) : yield* Effect.service(resource);
  const context = yield* Effect.context<Services>();
  const getService = <Service extends Context.Service.Any>(service: Service) =>
    Context.get(context, service);
  // @effect-diagnostics-next-line unknownInEffectCatch:off
  return yield* Effect.tryPromise({
    try: (signal) => callback({ resource: value, signal, getService }),
    catch: (cause) => cause,
  });
});

const adaptHooks = <Resource, Services>(
  hooks: ExtensionHooksDefinition<Resource, Services> | undefined,
  resource: Context.Service<Resource, Resource> | undefined,
): ExtensionHooks<Resource | Services> | undefined => {
  if (hooks === undefined) return undefined;
  const adapted: {
    -readonly [Key in keyof ExtensionHooks<Resource | Services>]?: ExtensionHooks<
      Resource | Services
    >[Key];
  } = {};
  const run = <A>(callback: (context: HookContext<Resource, Services>) => Promise<A>) =>
    promiseHook<A, Resource, Services>(callback, resource);
  const sessionStart = hooks.sessionStart;
  if (sessionStart) adapted.sessionStart = run(sessionStart);
  const sessionEnd = hooks.sessionEnd;
  if (sessionEnd) adapted.sessionEnd = run(sessionEnd);
  const turnStart = hooks.turnStart;
  if (turnStart) adapted.turnStart = (text) => run((context) => turnStart(text, context));
  const turnEnd = hooks.turnEnd;
  if (turnEnd) adapted.turnEnd = (text) => run((context) => turnEnd(text, context));
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
  readonly dependencies?: ReadonlyArray<Context.Service.Any>;
  readonly needsApproval?: Tool<any, any>["needsApproval"];
  readonly handler: (...args: never[]) => Promise<any>;
};
type RejectAny<Value> = 0 extends 1 & Value ? never : unknown;
type ToolResource<Value extends AnyTool> = Value extends unknown
  ? Parameters<Value["handler"]>[1] extends HookContext<infer Resource, any>
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
type ToolDependencyServices<Value extends AnyTool> = Value extends {
  readonly dependencies?: infer Dependencies;
}
  ? Dependencies extends ReadonlyArray<Context.Service.Any>
    ? RejectAny<Dependencies> extends never
      ? never
      : Context.Service.Identifier<Dependencies[number]>
    : never
  : never;
type ProvidedServicesOfExtension<Value> =
  RejectAny<Value> extends never
    ? never
    : Value extends Extension<any, any, any, infer Provides>
      ? RejectAny<Provides> extends never
        ? never
        : Context.Service.Identifier<Provides[number]>
      : never;
type ProvidedServices<Dependencies extends ReadonlyArray<AnyExtension>> =
  ProvidedServicesOfExtension<Dependencies[number]>;
type UnsatisfiedToolServices<Services, Value extends AnyTool> = Value extends unknown
  ? [ToolDependencyServices<Value>] extends [Services]
    ? never
    : ToolDependencyServices<Value>
  : never;
type UnionToIntersection<Value> = (Value extends unknown ? (value: Value) => void : never) extends (
  value: infer Intersection,
) => void
  ? Intersection
  : never;
type ProvidedTags<Provides extends ReadonlyArray<Context.Service.Any>> =
  RejectAny<Provides> extends never ? readonly [] : Provides;
type ProvidedImplementations<Provides extends ReadonlyArray<Context.Service.Any>> = [
  ProvidedTags<Provides>[number],
] extends [never]
  ? unknown
  : UnionToIntersection<ServiceValue<ProvidedTags<Provides>[number]>>;

type ToolContributions<Tools extends ReadonlyArray<AnyTool>> = {
  readonly [Value in Tools[number] as Value["name"]]: ToolContribution<
    Parameters<Value["handler"]>[0],
    Awaited<ReturnType<Value["handler"]>>
  >;
};

export interface ExtensionDefinition<
  Resource = never,
  Tools extends ReadonlyArray<AnyTool> = ReadonlyArray<Tool<any, any, Resource, string>>,
  Dependencies extends ReadonlyArray<AnyExtension> = readonly [],
  Provides extends ReadonlyArray<Context.Service.Any> = readonly [],
> {
  readonly name: string;
  readonly dependencies?: Dependencies;
  readonly provides?: Provides;
  readonly instructions?: string;
  readonly tools: Tools;
  readonly hooks?: ExtensionHooksDefinition<Resource, ProvidedServices<Dependencies>>;
  readonly setup?: () => Promise<Resource>;
  readonly dispose?: (resource: Resource) => Promise<void>;
}

// A declared Resource without setup would hand handlers `undefined as Resource`,
// so setup is mandatory whenever anything in the Extension declares a Resource.
export function defineExtension<
  Resource = never,
  const Tools extends ReadonlyArray<AnyTool> = ReadonlyArray<Tool<any, any, Resource, string>>,
  const Dependencies extends ReadonlyArray<AnyExtension> = readonly [],
  const Provides extends ReadonlyArray<Context.Service.Any> = readonly [],
>(
  definition: ExtensionDefinition<Resource, Tools, Dependencies, Provides> &
    ([UnsatisfiedToolResources<Resource, Tools[number]>] extends [never] ? unknown : never) &
    ([UnsatisfiedToolServices<ProvidedServices<NoInfer<Dependencies>>, Tools[number]>] extends [
      never,
    ]
      ? unknown
      : never) &
    ([Resource] extends [ProvidedImplementations<Provides>] ? unknown : never) &
    ([Resource | ToolResources<Tools> | ProvidedTags<Provides>[number]] extends [never]
      ? { readonly setup?: undefined; readonly dispose?: undefined }
      : { readonly setup: () => Promise<Resource> }),
): NoInfer<
  Extension<Resource | ProvidedServices<Dependencies>, unknown, ToolContributions<Tools>, Provides>
>;
export function defineExtension<
  Resource = never,
  Tools extends ReadonlyArray<AnyTool> = ReadonlyArray<Tool<any, any, Resource, string>>,
  Dependencies extends ReadonlyArray<AnyExtension> = ReadonlyArray<AnyExtension>,
  Provides extends ReadonlyArray<Context.Service.Any> = ReadonlyArray<Context.Service.Any>,
>(
  definition: ExtensionDefinition<Resource, Tools, Dependencies, Provides>,
): Extension<
  Resource | ProvidedServices<Dependencies>,
  unknown,
  ToolContributions<Tools>,
  Provides
> {
  if (definition.dispose !== undefined && definition.setup === undefined) {
    throw new Error(`Extension "${definition.name}" declares dispose without setup`);
  }
  const names = new Set<string>();
  const definitions = definition.tools.map((tool) => {
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
      needsApproval: Predicate.isFunction(needsApproval)
        ? (params: ToolHookContext["params"], context: ToolApprovalContext) =>
            // Rejections become defects, matching Core's fail-closed approval handling.
            Effect.promise(() => Promise.resolve().then(() => needsApproval(params, context)))
        : needsApproval,
    });
  });
  const toolInputValidators = Object.fromEntries(
    definitions.map(({ tool, input }) => [
      tool.name,
      (params: UnvalidatedToolInput) =>
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
      (result: UnvalidatedToolResult) =>
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
            (value) => {
              // SAFETY: the public overload verifies the setup value implements every provided Tag.
              let context = Context.make(service, value) as Context.Context<any>;
              for (const provided of definition.provides ?? []) {
                context = Context.add(context, provided, value);
              }
              return context;
            },
          ),
        );

  return {
    name: definition.name,
    dependencies: definition.dependencies,
    provides: definition.provides,
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
          promiseHook<any, Resource, ProvidedServices<Dependencies>>(async (context) => {
            // SAFETY: every public Tool overload fixes this erased handler to the same input/context pair.
            const handler = tool.handler as (
              input: any,
              context: HookContext<any, any>,
            ) => Promise<any>;
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
