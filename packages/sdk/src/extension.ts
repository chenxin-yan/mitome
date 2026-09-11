import { Context, Effect, Exit, Layer, Predicate, Schema } from "effect";
import {
  AiError,
  Prompt as AiPrompt,
  Response as AiResponse,
  Tool as AiTool,
  Toolkit,
} from "effect/unstable/ai";
import type {
  Extension,
  ExtensionHooks,
  ToolInputValidator as CoreToolInputValidator,
} from "@mitome/core";
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";
import type { Prompt, ResponsePart } from "./models.js";

// Structural view of an Effect Schema. Keeping this local lets the Promise entry point accept
// Effect-native schemas without publishing an Effect type in its declarations.
interface EffectSchema<Output> {
  readonly Type: Output;
  readonly Encoded: unknown;
  readonly DecodingServices: never;
  readonly EncodingServices: never;
}

/** Any Standard Schema v1 validator, such as a zod v4, valibot, or ArkType schema. */
export type StandardSchema<Input = unknown, Output = Input> = StandardSchemaV1<Input, Output>;
/**
 * Schema for Tool input: a Standard Schema that also emits JSON Schema (zod v4 does), or an
 * Effect Schema. The Model needs the JSON Schema; the validator decodes what it sends back.
 */
export type InputSchema<Input = unknown> =
  | (StandardSchemaV1<unknown, Input> & StandardJSONSchemaV1<unknown, Input>)
  | EffectSchema<Input>;
/** Schema for a Tool's output or expected failure; validation only, no JSON Schema needed. */
export type OutputSchema<Output = unknown> =
  | StandardSchemaV1<unknown, Output>
  | EffectSchema<Output>;

/** Passed to every Promise Hook and Tool handler. */
export interface HookContext<Resource = never> {
  /** The Extension's Resource from `setup`; `never` for Extensions without one. */
  readonly resource: Resource;
  /** Aborts when the Turn is interrupted, so external work can stop with it. */
  readonly signal: AbortSignal;
}

type UnvalidatedToolInput = Parameters<CoreToolInputValidator>[0];
type StandardInputValue = Parameters<StandardSchemaV1.Props["validate"]>[0];

/** The Tool call a `preTool` Hook observes: its name and decoded input. */
export interface ToolHookContext {
  readonly name: string;
  readonly params: unknown;
}

/** The Tool result a `postTool` Hook observes; `isFailure` marks an expected failure value. */
export interface ToolResultHookContext extends ToolHookContext {
  readonly result: unknown;
  readonly isFailure: boolean;
}

/** Type-level record of one Tool's input, output, and expected failure types. */
export interface ToolContribution<Input = unknown, Output = unknown, Failure = never> {
  readonly input: Input;
  readonly output: Output;
  readonly failure: Failure;
}

/** `stepEnd` context: the response parts the Step emitted; failed Steps include partial parts. */
export interface StepEndContext<Resource = never> extends HookContext<Resource> {
  readonly responseParts: ReadonlyArray<ResponsePart>;
}

/** Passed to a `needsApproval` predicate alongside the decoded input. */
export interface ToolApprovalContext {
  readonly toolCallId: string;
  /** Messages of the current Model Prompt. */
  readonly messages: ReadonlyArray<unknown>;
}

/**
 * Promise lifecycle Hooks. Start Hooks run in Agent Definition order and end Hooks in reverse; a
 * rejected Hook fails the Turn (or Session start) with `TurnError`, except `sessionEnd`, whose
 * rejection is logged so Session release always completes.
 */
export interface ExtensionHooksDefinition<Resource = never> {
  /** Runs once after every Extension Resource is acquired. */
  readonly sessionStart?: (context: HookContext<Resource>) => Promise<void>;
  /** Runs when the Session is released, before Resources are disposed; a rejection is logged, not thrown. */
  readonly sessionEnd?: (context: HookContext<Resource>) => Promise<void>;
  /** Observes the user Message that starts a Turn. */
  readonly turnStart?: (message: string, context: HookContext<Resource>) => Promise<void>;
  /** Observes the user Message after its Turn completed successfully. */
  readonly turnEnd?: (message: string, context: HookContext<Resource>) => Promise<void>;
  /** Observes the Model Prompt before one Step. */
  readonly stepStart?: (prompt: Prompt, context: HookContext<Resource>) => Promise<void>;
  /** Receives the Model Prompt and emitted response parts; failed Steps provide their partial parts. */
  readonly stepEnd?: (prompt: Prompt, context: StepEndContext<Resource>) => Promise<void>;
  /** Returns the Model Prompt to send for one Step, transformed or unchanged. */
  readonly preStep?: (prompt: Prompt, context: HookContext<Resource>) => Promise<Prompt>;
  /**
   * Policy check before a Tool runs: return `{ reason }` to veto the call, which the Model then
   * sees as a denied execution. Approval is a separate Host decision after this Hook passes.
   */
  readonly preTool?: (
    context: ToolHookContext & HookContext<Resource>,
  ) => Promise<void | { readonly reason: string }>;
  /** Observes and returns the Tool result, transformed or unchanged; it is revalidated afterwards. */
  readonly postTool?: (
    context: ToolResultHookContext & HookContext<Resource>,
  ) => Promise<ToolResultHookContext["result"]>;
}

/** Expected success of a Tool with a `failureSchema`; create it with `ok()`. */
export interface ToolSuccess<Output> {
  readonly ok: true;
  readonly value: Output;
}

/** Expected failure of a Tool with a `failureSchema`; create it with `fail()`. */
export interface ToolFailure<Failure> {
  readonly ok: false;
  readonly error: Failure;
}

/** Wraps a Tool result as an expected success; required when the Tool declares a `failureSchema`. */
export const ok = <const Output>(value: Output): ToolSuccess<Output> => ({ ok: true, value });
/**
 * Wraps an expected failure the Model should see and react to; it is validated against
 * `failureSchema`. Throwing instead is a defect and yields an opaque failed result.
 */
export const fail = <const Failure>(error: Failure): ToolFailure<Failure> => ({ ok: false, error });

declare const ToolTypeId: unique symbol;

/** A Promise Tool declared through a `ToolBuilder`. */
export interface Tool<
  Input = unknown,
  Output = unknown,
  Failure = never,
  Resource = never,
  Name extends string = string,
> {
  /** @internal */
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
  /** Pauses the Turn with `approval-required` before running: a boolean or an input-aware predicate. */
  readonly needsApproval?:
    | boolean
    | ((input: Input, context: ToolApprovalContext) => boolean | Promise<boolean>);
  /**
   * Runs the Tool with validated input. Return `ok()`/`fail()` when a `failureSchema` is declared,
   * otherwise the output directly. A rejection is a defect the Model sees as an opaque failure.
   */
  readonly handler: (
    input: Input,
    context: HookContext<Resource>,
  ) => Promise<Output | ToolSuccess<Output> | ToolFailure<Failure>>;
}

type ToolOptions<Input> = Pick<Tool<Input>, "description" | "inputSchema" | "needsApproval">;

/** A Tool declaration function scoped to one Extension Resource. */
export interface ToolBuilder<in out Resource = never> {
  /** With `outputSchema` and `failureSchema`: the handler returns `ok()` or `fail()`, both validated. */
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
  /** With `outputSchema` only: the handler returns the output, which is validated. */
  <Input, Output, const Name extends string>(
    definition: ToolOptions<Input> & {
      readonly name: Name;
      readonly outputSchema: OutputSchema<Output>;
      readonly failureSchema?: undefined;
      readonly handler: (input: Input, context: HookContext<Resource>) => Promise<NoInfer<Output>>;
    },
  ): Tool<Input, Output, never, Resource, Name>;
  /** Without schemas: the output is inferred from the handler and passed through unvalidated. */
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
    // SAFETY: Schema.isSchema established the full Effect Schema protocol; the public structural
    // view fixes the same decoded Input and excludes service requirements.
    const effectSchema = schema as Schema.Codec<Input, unknown, never, never>;
    return Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(effectSchema))["~standard"];
  }
  // SAFETY: the Effect branch returned above, leaving the Standard Schema union member.
  const standard = (
    schema as StandardSchemaV1<unknown, Input> & StandardJSONSchemaV1<unknown, Input>
  )["~standard"];
  if (!("validate" in standard) || !("jsonSchema" in standard)) {
    throw new Error("Tool input schema must provide validation and JSON Schema");
  }
  return standard;
};

const standardOutput = <Output>(
  schema: OutputSchema<Output>,
): StandardSchemaV1.Props<unknown, Output> => {
  if (Schema.isSchema(schema)) {
    // SAFETY: Schema.isSchema established the full Effect Schema protocol; the public structural
    // view fixes the same decoded Output and excludes service requirements.
    const effectSchema = schema as Schema.Codec<Output, unknown, never, never>;
    return Schema.toStandardSchemaV1(effectSchema)["~standard"];
  }
  // SAFETY: the Effect branch returned above, leaving the Standard Schema union member.
  const standard = (schema as StandardSchemaV1<unknown, Output>)["~standard"];
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

const toPrompt: (prompt: AiPrompt.Prompt) => Prompt = Schema.encodeSync(AiPrompt.Prompt);

const toResponsePart = (responsePart: AiResponse.AnyPart): ResponsePart => {
  const { ["~effect/ai/Content/Part"]: _, ...part } = responsePart;
  if (part.type === "finish") {
    return {
      ...part,
      usage: {
        inputTokens: { ...part.usage.inputTokens },
        outputTokens: { ...part.usage.outputTokens },
      },
    };
  }
  if (part.type === "tool-result") {
    const { encodedResult: _, ...toolResult } = part;
    return toolResult;
  }
  return part;
};

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
  if (stepStart)
    adapted.stepStart = (prompt) => run((context) => stepStart(toPrompt(prompt), context));
  const stepEnd = hooks.stepEnd;
  if (stepEnd)
    adapted.stepEnd = (prompt, responseParts) =>
      run((context) =>
        stepEnd(toPrompt(prompt), {
          ...context,
          responseParts: responseParts.map(toResponsePart),
        }),
      );
  const preStep = hooks.preStep;
  if (preStep)
    adapted.preStep = (prompt) =>
      run((context) => preStep(toPrompt(prompt), context)).pipe(
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

/** Any Promise Tool regardless of its input, output, failure, or Resource types. */
export type AnyTool = {
  /** @internal */
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
  /** Erased handler; see `Tool.handler` for the contract. */
  readonly handler: (...args: never[]) => Promise<any>;
};
type ToolTypes<Value extends AnyTool> = NonNullable<Value[typeof ToolTypeId]>;

/** Tool name to `ToolContribution` map derived from the Tools a builder returned. */
export type ToolContributionsOf<Tools extends ReadonlyArray<AnyTool>> = {
  readonly [Value in Tools[number] as Value["name"]]: ToolContribution<
    ToolTypes<Value>["input"],
    ToolTypes<Value>["output"],
    ToolTypes<Value>["failure"]
  >;
};

/** Input to `defineExtension`. */
export interface ExtensionDefinition<
  Resource = never,
  Tools extends ReadonlyArray<AnyTool> = readonly [],
> {
  /** Label for diagnostics; unnamed Extensions are identified by reference. */
  readonly name?: string;
  /** Static Instructions fragment composed into the system prompt in Agent Definition order. */
  readonly instructions?: string;
  /** Declares Tools with a builder whose handlers receive this Extension's Resource. */
  readonly tools?: (scope: { readonly tool: ToolBuilder<Resource> }) => Tools;
  readonly hooks?: ExtensionHooksDefinition<Resource>;
  /** Acquires the Resource once when a Session starts; required whenever Hooks or Tools use one. */
  readonly setup?: () => Promise<Resource>;
  /** Releases the Resource when the Session is released, including on failure and interruption; requires `setup`. */
  readonly dispose?: (resource: Resource) => Promise<void>;
}

/**
 * Declares a Promise Extension without Tools: Instructions, Hooks, and an optional Resource. A
 * Resource is private to its Extension, so put Hooks that share state in one Extension.
 */
export function defineExtension<Resource = never>(
  definition: ExtensionDefinition<Resource, readonly []> &
    ([Resource] extends [never]
      ? { readonly setup?: undefined; readonly dispose?: undefined }
      : { readonly setup: () => Promise<Resource> }),
): NoInfer<Extension<Resource, unknown, ToolContributionsOf<readonly []>>>;
/**
 * Declares a Promise Extension with Tools. Tool names must be unique within the Extension, and
 * `dispose` requires `setup`; both throw at definition time.
 */
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
