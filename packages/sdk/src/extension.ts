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

export interface ToolSuccess<Output> {
  readonly ok: true;
  readonly value: Output;
}

export interface ToolFailure<Failure> {
  readonly ok: false;
  readonly error: Failure;
}

export const ok = <const Output>(value: Output): ToolSuccess<Output> => ({ ok: true, value });
export const fail = <const Failure>(error: Failure): ToolFailure<Failure> => ({ ok: false, error });

declare const ToolTypeId: unique symbol;

export interface Tool<
  Input = unknown,
  Output = unknown,
  Failure = never,
  Resource = never,
  Name extends string = string,
> {
  readonly [ToolTypeId]?: {
    readonly input: Input;
    readonly output: Output;
    readonly failure: Failure;
    readonly resource: Resource;
  };
  readonly name: Name;
  readonly description?: string;
  readonly inputSchema: InputSchema<Input>;
  readonly outputSchema?: OutputSchema<Output>;
  readonly failureSchema?: OutputSchema<Failure>;
  readonly needsApproval?:
    | boolean
    | ((input: Input, context: ToolApprovalContext) => boolean | Promise<boolean>);
  readonly handler: (
    input: Input,
    context: HookContext<Resource>,
  ) => Promise<Output | ToolSuccess<Output> | ToolFailure<Failure>>;
}

type ToolOptions<Input> = Pick<Tool<Input>, "description" | "inputSchema" | "needsApproval">;

/** A Tool declaration function scoped to one Extension Resource. */
export interface ToolBuilder<in out Resource = never> {
  <Input, Output, Failure, const Name extends string>(
    definition: ToolOptions<Input> & {
      readonly name: Name;
      readonly outputSchema: OutputSchema<Output>;
      readonly failureSchema: OutputSchema<Failure>;
      readonly handler: (
        input: Input,
        context: HookContext<Resource>,
      ) => Promise<ToolSuccess<NoInfer<Output>> | ToolFailure<NoInfer<Failure>>>;
    },
  ): Tool<Input, Output, Failure, Resource, Name>;
  <Input, Output, const Name extends string>(
    definition: ToolOptions<Input> & {
      readonly name: Name;
      readonly outputSchema: OutputSchema<Output>;
      readonly failureSchema?: undefined;
      readonly handler: (input: Input, context: HookContext<Resource>) => Promise<NoInfer<Output>>;
    },
  ): Tool<Input, Output, never, Resource, Name>;
  <Input, Output, const Name extends string>(
    definition: ToolOptions<Input> & {
      readonly name: Name;
      readonly outputSchema?: undefined;
      readonly failureSchema?: undefined;
      readonly handler: (input: Input, context: HookContext<Resource>) => Promise<Output>;
    },
  ): Tool<Input, Output, never, Resource, Name>;
}

const toolBuilder: ToolBuilder<any> = (definition: any) => definition;

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

export type AnyTool = {
  readonly [ToolTypeId]?: {
    readonly input: any;
    readonly output: any;
    readonly failure: any;
    readonly resource: any;
  };
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: InputSchema<any>;
  readonly outputSchema?: OutputSchema<any>;
  readonly failureSchema?: OutputSchema<any>;
  readonly needsApproval?: Tool<any, any>["needsApproval"];
  readonly handler: (...args: never[]) => Promise<any>;
};
type ToolTypes<Value extends AnyTool> = NonNullable<Value[typeof ToolTypeId]>;

export type ToolContributionsOf<Tools extends ReadonlyArray<AnyTool>> = {
  readonly [Value in Tools[number] as Value["name"]]: ToolContribution<
    ToolTypes<Value>["input"],
    ToolTypes<Value>["output"],
    ToolTypes<Value>["failure"]
  >;
};

export interface ExtensionDefinition<
  Resource = never,
  Tools extends ReadonlyArray<AnyTool> = readonly [],
> {
  readonly name?: string;
  readonly instructions?: string;
  readonly tools?: (scope: { readonly tool: ToolBuilder<Resource> }) => Tools;
  readonly hooks?: ExtensionHooksDefinition<Resource>;
  readonly setup?: () => Promise<Resource>;
  readonly dispose?: (resource: Resource) => Promise<void>;
}

export function defineExtension<Resource = never>(
  definition: ExtensionDefinition<Resource, readonly []> &
    ([Resource] extends [never]
      ? { readonly setup?: undefined; readonly dispose?: undefined }
      : { readonly setup: () => Promise<Resource> }),
): NoInfer<Extension<Resource, unknown, ToolContributionsOf<readonly []>>>;
export function defineExtension<
  Resource = never,
  const Tools extends ReadonlyArray<AnyTool> = [Resource] extends [never]
    ? readonly []
    : ReadonlyArray<AnyTool>,
>(
  definition: ExtensionDefinition<Resource, Tools> & {
    readonly tools: (scope: { readonly tool: ToolBuilder<Resource> }) => Tools;
  } & ([Resource] extends [never]
      ? { readonly setup?: undefined; readonly dispose?: undefined }
      : { readonly setup: () => Promise<Resource> }),
): NoInfer<Extension<Resource, unknown, ToolContributionsOf<Tools>>>;
export function defineExtension<
  Resource = never,
  Tools extends ReadonlyArray<AnyTool> = readonly [],
>(
  definition: ExtensionDefinition<Resource, Tools>,
): Extension<Resource, unknown, ToolContributionsOf<Tools>> {
  if (definition.dispose !== undefined && definition.setup === undefined) {
    throw new Error(
      `Extension "${definition.name ?? "<anonymous>"}" declares dispose without setup`,
    );
  }
  const names = new Set<string>();
  const definitions = (
    definition.tools === undefined ? [] : definition.tools({ tool: toolBuilder })
  ).map((tool) => {
    if (names.has(tool.name)) throw new Error(`Duplicate Tool name: ${tool.name}`);
    names.add(tool.name);
    return {
      tool,
      input: standardInput(tool.inputSchema),
      output: tool.outputSchema === undefined ? undefined : standardOutput(tool.outputSchema),
      failure: tool.failureSchema === undefined ? undefined : standardOutput(tool.failureSchema),
    };
  });

  const service = definition.setup === undefined ? undefined : ResourceService;
  const hooks = adaptHooks(definition.hooks, service);
  const tools = definitions.map(({ tool, input }) => {
    const needsApproval = tool.needsApproval;
    return AiTool.dynamic(tool.name, {
      description: tool.description,
      parameters: input.jsonSchema.input({ target: "draft-2020-12" }),
      failure: tool.failureSchema === undefined ? undefined : Schema.Unknown,
      failureMode: "return",
      needsApproval: Predicate.isFunction(needsApproval)
        ? (params: ToolHookContext["params"], context: ToolApprovalContext) =>
            // Rejections become defects, matching Core's fail-closed approval handling.
            Effect.promise(async () => needsApproval(params, context))
        : needsApproval,
    });
  });
  const validators = (
    pick: (
      definition: (typeof definitions)[number],
    ) => StandardSchemaV1.Props<unknown, unknown> | undefined,
  ) =>
    Object.fromEntries(
      definitions.flatMap((definition) => {
        const schema = pick(definition);
        return schema === undefined
          ? []
          : [
              [
                definition.tool.name,
                (value: StandardInputValue) =>
                  // @effect-diagnostics-next-line unknownInEffectCatch:off
                  Effect.tryPromise({
                    try: () => validate(schema, value),
                    catch: (cause) => cause,
                  }),
              ] as const,
            ];
      }),
    );
  const toolInputValidators = validators(({ input }) => input);
  const toolResultValidators = validators(({ output }) => output);
  const toolFailureValidators = validators(({ failure }) => failure);

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
    toolFailureValidators,
    handlers: Object.fromEntries(
      definitions.map(({ tool, input, output, failure }) => [
        tool.name,
        (params: UnvalidatedToolInput) =>
          promiseHook<any, Resource>(async (context) => {
            // SAFETY: ToolBuilder fixes this erased handler to the same input/context pair.
            const handler = tool.handler as (input: any, context: HookContext<any>) => Promise<any>;
            const result = await handler(await validate(input, params), context);
            if (failure !== undefined) {
              if (result.ok) {
                return { ok: true as const, value: await validate(output!, result.value) };
              }
              return { ok: false as const, error: await validate(failure, result.error) };
            }
            return output === undefined ? result : validate(output, result);
          }, service).pipe(
            Effect.tapError((cause) => Effect.logWarning(`SDK Tool "${tool.name}" failed`, cause)),
            // Rejections and validation errors are defects; the model gets a stable failure instead.
            Effect.mapError(() =>
              AiError.make({
                module: "@mitome/sdk",
                method: tool.name,
                reason: new AiError.UnknownError({ description: "SDK tool handler failed" }),
              }),
            ),
            Effect.flatMap((result) =>
              failure === undefined
                ? Effect.succeed(result)
                : result.ok
                  ? Effect.succeed(result.value)
                  : Effect.fail(result.error),
            ),
          ),
      ]),
    ),
  };
}
