import { Context, Effect, Layer, Schema } from "effect";
import { Prompt, Tool, Toolkit } from "effect/unstable/ai";
import type { Response } from "effect/unstable/ai";

/** Decoded parameters of any Tool call. */
export type ToolInput = Tool.Parameters<Tool.Any>;
/** Result value of any Tool handler. */
export type ToolOutput = Tool.HandlerResult<Tool.Any>["result"];

/** The Tool call a `preTool` Hook observes. */
export interface ToolHookContext {
  readonly name: string;
  readonly params: ToolInput;
}

/** The Tool result a `postTool` Hook observes; `isFailure` marks an expected failure value. */
export interface ToolResultHookContext extends ToolHookContext {
  readonly result: ToolOutput;
  readonly isFailure: boolean;
}

/**
 * Effect-native lifecycle Hooks. Start Hooks run in Agent Definition order and end Hooks in
 * reverse; a failing Hook fails the Turn (or Session start) with `TurnError`.
 */
export interface ExtensionHooks<Resource = never> {
  /** Runs once after every Extension Resource is acquired. */
  readonly sessionStart?: Effect.Effect<void, unknown, Resource>;
  /** Runs when the Session scope closes, before Resources are released. */
  readonly sessionEnd?: Effect.Effect<void, unknown, Resource>;
  /** Observes the user Message that starts a Turn. */
  readonly turnStart?: (message: string) => Effect.Effect<void, unknown, Resource>;
  /** Observes the user Message after its Turn completed successfully. */
  readonly turnEnd?: (message: string) => Effect.Effect<void, unknown, Resource>;
  /** Observes the Model Prompt before one Step. */
  readonly stepStart?: (prompt: Prompt.Prompt) => Effect.Effect<void, unknown, Resource>;
  /** Receives the Model Prompt and emitted response parts; failed Steps provide their partial parts. */
  readonly stepEnd?: (
    prompt: Prompt.Prompt,
    responseParts: ReadonlyArray<Response.AnyPart>,
  ) => Effect.Effect<void, unknown, Resource>;
  /** Returns the Model Prompt to send for one Step, transformed or unchanged. */
  readonly preStep?: (prompt: Prompt.Prompt) => Effect.Effect<Prompt.Prompt, unknown, Resource>;
  /**
   * Policy check before a Tool runs: return `{ reason }` to veto the call, which the Model then
   * sees as a denied execution. Approval is a separate Host decision after this Hook passes.
   */
  readonly preTool?: (
    context: ToolHookContext,
  ) => Effect.Effect<void | { readonly reason: string }, unknown, Resource>;
  /** Observes and may transform successful or failed Tool handler results. */
  readonly postTool?: (
    context: ToolResultHookContext,
  ) => Effect.Effect<ToolOutput, unknown, Resource>;
}

/** Decodes raw Tool params before Hooks, approval predicates, and handlers see them. */
export type ToolInputValidator = (input: ToolInput) => Effect.Effect<ToolInput, unknown>;
/** Revalidates a successful Tool result, including after `postTool` transforms. */
export type ToolResultValidator = (result: ToolOutput) => Effect.Effect<ToolOutput, unknown>;
/** Revalidates an expected failure value, including after `postTool` transforms. */
export type ToolFailureValidator = (failure: ToolOutput) => Effect.Effect<ToolOutput, unknown>;

/** Type-level record of one Tool's input, output, and expected failure types. */
export interface ToolContribution<Input = ToolInput, Output = ToolOutput, Failure = never> {
  readonly input: Input;
  readonly output: Output;
  readonly failure: Failure;
}

/** The Tools an Extension advertises at the type level, keyed by Tool name. */
export type ToolContributions = Readonly<
  Record<string, ToolContribution<unknown, unknown, unknown>>
>;
type EmptyToolContributions = Readonly<Record<never, never>>;
type ToolkitContributions<Tools extends Record<string, Tool.Any>> = {
  readonly [Name in keyof Tools]: ToolContribution<
    Tool.Parameters<Tools[Name]>,
    Tool.Success<Tools[Name]>,
    Tool.Failure<Tools[Name]>
  >;
};
declare const ExtensionContributionsTypeId: unique symbol;

/**
 * A reusable unit an Agent Definition includes to add Tools, contribute Instructions, or
 * participate in the Agent lifecycle. Identity is the object reference; `name` only labels
 * diagnostics, and two different named Extensions with the same name conflict.
 */
export interface Extension<
  Resource = never,
  ResourceError = never,
  Contributions extends ToolContributions = EmptyToolContributions,
> {
  /** @internal */
  readonly [ExtensionContributionsTypeId]?: Contributions;
  readonly name?: string | undefined;
  /** Static Instructions fragment composed into the system prompt in Agent Definition order. */
  readonly instructions?: string | undefined;
  /** Required at runtime whenever hooks or handlers use a Resource; hooks run unprovided (missing-service defect) without it. */
  readonly resource?: Layer.Layer<Resource, ResourceError, any> | undefined;
  /** Tools this Extension contributes; names must be unique across the Agent Definition. */
  readonly toolkit?: Toolkit.Any;
  /** Tool handlers by Tool name; required for every Tool in `toolkit` that needs one. */
  readonly handlers?: Record<
    string,
    (params: ToolInput) => Effect.Effect<ToolOutput, unknown, Resource>
  >;
  /** Decodes Tool input for Hooks, approval predicates, and approval events. */
  readonly toolInputValidators?: Readonly<Record<string, ToolInputValidator>>;
  /** Revalidates post-Tool transforms; keys must name Tools in this Extension. */
  readonly toolResultValidators?: Readonly<Record<string, ToolResultValidator>>;
  /** Revalidates failed results after post-Tool transforms. */
  readonly toolFailureValidators?: Readonly<Record<string, ToolFailureValidator>>;
  /** Lifecycle Hooks; those that use the Resource require `resource`. */
  readonly hooks?: ExtensionHooks<Resource> | undefined;
}

/**
 * Any Extension regardless of its Resource. Layer's ROut is contravariant while
 * hook/handler Effects are covariant in R, so no single parameterization
 * accepts every Extension; the union's arms cover both variance directions.
 */
export type AnyExtension = Extension<any, unknown, any> | Extension<never, any, any>;

type RejectAny<Value> = 0 extends 1 & Value ? never : unknown;
type ServiceCoverage<Tools extends Record<string, Tool.Any>, Services> = [
  Tool.HandlerServices<Tools[keyof Tools]> | Tool.ResultDecodingServices<Tools[keyof Tools]>,
] extends [Services]
  ? unknown
  : never;

type LayerExtension<LayerValue extends Layer.Any> = Omit<
  Extension<Layer.Success<LayerValue>, Layer.Error<LayerValue>>,
  "resource" | "hooks"
> & {
  readonly resource?: LayerValue | undefined;
  readonly hooks?: ExtensionHooks<NoInfer<Layer.Success<LayerValue>>> | undefined;
};

type ToolkitlessExtension<LayerValue extends Layer.Any> = Omit<
  LayerExtension<LayerValue>,
  "toolkit" | "handlers" | "toolInputValidators" | "toolResultValidators" | "toolFailureValidators"
> & {
  readonly toolkit?: undefined;
  readonly handlers?: undefined;
  readonly toolInputValidators?: undefined;
  readonly toolResultValidators?: undefined;
  readonly toolFailureValidators?: undefined;
};

type ResourceFreeToolkitlessExtension = Omit<
  ToolkitlessExtension<Layer.Layer<never, never, never>>,
  "resource" | "hooks"
> & {
  readonly resource?: undefined;
  readonly hooks?: ExtensionHooks<never> | undefined;
};

type ToolkitExtension<ToolkitValue extends Toolkit.Any> = {
  readonly name?: string | undefined;
  readonly instructions?: string | undefined;
  readonly resource?: undefined;
  readonly toolkit: ToolkitValue;
  readonly handlers: Toolkit.HandlersFrom<Toolkit.Tools<NoInfer<ToolkitValue>>> &
    ServiceCoverage<Toolkit.Tools<NoInfer<ToolkitValue>>, never>;
  readonly toolInputValidators?: Readonly<
    Partial<Record<keyof Toolkit.Tools<NoInfer<ToolkitValue>> & string, ToolInputValidator>>
  >;
  readonly toolResultValidators?: Readonly<
    Partial<Record<keyof Toolkit.Tools<NoInfer<ToolkitValue>> & string, ToolResultValidator>>
  >;
  readonly toolFailureValidators?: Readonly<
    Partial<Record<keyof Toolkit.Tools<NoInfer<ToolkitValue>> & string, ToolFailureValidator>>
  >;
  readonly hooks?: ExtensionHooks<never> | undefined;
};

type ResourcefulToolkitExtension<
  LayerValue extends Layer.Any,
  ToolkitValue extends Toolkit.Any,
> = Omit<
  LayerExtension<LayerValue>,
  | "resource"
  | "toolkit"
  | "handlers"
  | "toolInputValidators"
  | "toolResultValidators"
  | "toolFailureValidators"
  | "hooks"
> & {
  readonly resource: LayerValue;
  readonly toolkit: ToolkitValue;
  readonly handlers: Toolkit.HandlersFrom<Toolkit.Tools<NoInfer<ToolkitValue>>> &
    ServiceCoverage<Toolkit.Tools<NoInfer<ToolkitValue>>, Layer.Success<NoInfer<LayerValue>>>;
  readonly toolInputValidators?: Readonly<
    Partial<Record<keyof Toolkit.Tools<NoInfer<ToolkitValue>> & string, ToolInputValidator>>
  >;
  readonly toolResultValidators?: Readonly<
    Partial<Record<keyof Toolkit.Tools<NoInfer<ToolkitValue>> & string, ToolResultValidator>>
  >;
  readonly toolFailureValidators?: Readonly<
    Partial<Record<keyof Toolkit.Tools<NoInfer<ToolkitValue>> & string, ToolFailureValidator>>
  >;
  readonly hooks?: ExtensionHooks<Layer.Success<NoInfer<LayerValue>>> | undefined;
};

/**
 * Declares an Effect-native Extension whose Hooks use a Resource `Layer` and contributes no Tools.
 * The Layer is built when a Session starts and released, in reverse order, when its scope closes.
 */
export function defineExtension<const LayerValue extends Layer.Layer<any, any, never>>(
  extension: ToolkitlessExtension<LayerValue> & {
    readonly resource: LayerValue;
  } & RejectAny<LayerValue>,
): NoInfer<Extension<Layer.Success<LayerValue>, Layer.Error<LayerValue>>>;
/** Declares an Extension with Instructions and Hooks only, needing no Resource or Tools. */
export function defineExtension(
  extension: ResourceFreeToolkitlessExtension,
): NoInfer<Extension<never, never, EmptyToolContributions>>;
/**
 * Declares an Extension that contributes an Effect `Toolkit` without a Resource. Every Tool needs
 * a handler, and handlers may not require services the Extension does not provide.
 */
export function defineExtension<const ToolkitValue extends Toolkit.Any>(
  extension: ToolkitExtension<ToolkitValue>,
): Extension<never, never, ToolkitContributions<Toolkit.ToolsByName<Toolkit.Tools<ToolkitValue>>>>;
/**
 * Declares an Extension whose Toolkit handlers and Hooks share one Resource `Layer`. Service
 * requirements the Layer does not satisfy are rejected at the type level.
 */
export function defineExtension<
  const LayerValue extends Layer.Layer<any, any, never>,
  const ToolkitValue extends Toolkit.Any,
>(
  extension: ResourcefulToolkitExtension<LayerValue, ToolkitValue> & RejectAny<LayerValue>,
): Extension<
  Layer.Success<LayerValue>,
  Layer.Error<LayerValue>,
  ToolkitContributions<Toolkit.ToolsByName<Toolkit.Tools<ToolkitValue>>>
>;
// The impl return must be assignable to every overload return; only never is.
export function defineExtension(extension: typeof Schema.Unknown.Type): never {
  // SAFETY: overload resolution validates every public call; this erased implementation is unreachable.
  return extension as never;
}

export type ExtensionContexts = ReadonlyMap<AnyExtension, Context.Context<any>>;

export const provideExtension = <A, E>(
  extension: AnyExtension,
  contexts: ExtensionContexts,
  effect: Effect.Effect<A, E, any>,
): Effect.Effect<A, E> => {
  const context = contexts.get(extension);
  // SAFETY: providing the extension's compiled context removes its erased service requirement.
  return (context === undefined ? effect : Effect.provide(effect, context)) as Effect.Effect<A, E>;
};

export const provideExtensionHook = <A, E>(
  extension: AnyExtension,
  contexts: ExtensionContexts,
  effect: Effect.Effect<A, E, any> | undefined,
): Effect.Effect<A, E> | undefined =>
  effect === undefined ? undefined : provideExtension(extension, contexts, effect);
