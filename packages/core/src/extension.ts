import { Context, Effect, Layer, Schema } from "effect";
import { Prompt, Tool, Toolkit } from "effect/unstable/ai";
import type { Response } from "effect/unstable/ai";

export type ToolInput = Tool.Parameters<Tool.Any>;
export type ToolOutput = Tool.HandlerResult<Tool.Any>["result"];

export interface ToolHookContext {
  readonly name: string;
  readonly params: ToolInput;
}

export interface ToolResultHookContext extends ToolHookContext {
  readonly result: ToolOutput;
  readonly isFailure: boolean;
}

export interface ExtensionHooks<Resource = never> {
  readonly sessionStart?: Effect.Effect<void, unknown, Resource>;
  readonly sessionEnd?: Effect.Effect<void, unknown, Resource>;
  readonly turnStart?: (message: string) => Effect.Effect<void, unknown, Resource>;
  readonly turnEnd?: (message: string) => Effect.Effect<void, unknown, Resource>;
  readonly stepStart?: (prompt: Prompt.Prompt) => Effect.Effect<void, unknown, Resource>;
  /** Receives the model prompt and emitted response parts; failed Steps provide their partial parts. */
  readonly stepEnd?: (
    prompt: Prompt.Prompt,
    responseParts: ReadonlyArray<Response.AnyPart>,
  ) => Effect.Effect<void, unknown, Resource>;
  readonly preStep?: (prompt: Prompt.Prompt) => Effect.Effect<Prompt.Prompt, unknown, Resource>;
  readonly preTool?: (
    context: ToolHookContext,
  ) => Effect.Effect<void | { readonly reason: string }, unknown, Resource>;
  /** Observes and may transform successful or failed Tool handler results. */
  readonly postTool?: (
    context: ToolResultHookContext,
  ) => Effect.Effect<ToolOutput, unknown, Resource>;
}

export type ToolInputValidator = (input: ToolInput) => Effect.Effect<ToolInput, unknown>;
export type ToolResultValidator = (result: ToolOutput) => Effect.Effect<ToolOutput, unknown>;

export interface ToolContribution<Input = ToolInput, Output = ToolOutput> {
  readonly input: Input;
  readonly output: Output;
}

export type ToolContributions = Readonly<Record<string, ToolContribution>>;
type EmptyToolContributions = Readonly<Record<never, never>>;
type ToolkitContributions<Tools extends Record<string, Tool.Any>> = {
  readonly [Name in keyof Tools]: ToolContribution<
    Tool.Parameters<Tools[Name]>,
    Tool.Success<Tools[Name]>
  >;
};
declare const ExtensionContributionsTypeId: unique symbol;

export interface Extension<
  Resource = never,
  ResourceError = never,
  Contributions extends ToolContributions = EmptyToolContributions,
> {
  readonly [ExtensionContributionsTypeId]?: Contributions;
  readonly name?: string | undefined;
  readonly instructions?: string | undefined;
  /** Required at runtime whenever hooks or handlers use a Resource; hooks run unprovided (missing-service defect) without it. */
  readonly resource?: Layer.Layer<Resource, ResourceError, any> | undefined;
  readonly toolkit?: Toolkit.Any;
  readonly handlers?: Record<
    string,
    (params: ToolInput) => Effect.Effect<ToolOutput, unknown, Resource>
  >;
  /** Decodes Tool input for Hooks, approval predicates, and approval events. */
  readonly toolInputValidators?: Readonly<Record<string, ToolInputValidator>>;
  /** Revalidates post-Tool transforms; keys must name Tools in this Extension. */
  readonly toolResultValidators?: Readonly<Record<string, ToolResultValidator>>;
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
  "toolkit" | "handlers" | "toolInputValidators" | "toolResultValidators"
> & {
  readonly toolkit?: undefined;
  readonly handlers?: undefined;
  readonly toolInputValidators?: undefined;
  readonly toolResultValidators?: undefined;
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
  readonly hooks?: ExtensionHooks<never> | undefined;
};

type ResourcefulToolkitExtension<
  LayerValue extends Layer.Any,
  ToolkitValue extends Toolkit.Any,
> = Omit<
  LayerExtension<LayerValue>,
  "resource" | "toolkit" | "handlers" | "toolInputValidators" | "toolResultValidators" | "hooks"
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
  readonly hooks?: ExtensionHooks<Layer.Success<NoInfer<LayerValue>>> | undefined;
};

export function defineExtension<const LayerValue extends Layer.Layer<any, any, never>>(
  extension: ToolkitlessExtension<LayerValue> & {
    readonly resource: LayerValue;
  } & RejectAny<LayerValue>,
): NoInfer<Extension<Layer.Success<LayerValue>, Layer.Error<LayerValue>>>;
export function defineExtension(
  extension: ResourceFreeToolkitlessExtension,
): NoInfer<Extension<never, never, EmptyToolContributions>>;
export function defineExtension<const ToolkitValue extends Toolkit.Any>(
  extension: ToolkitExtension<ToolkitValue>,
): Extension<never, never, ToolkitContributions<Toolkit.ToolsByName<Toolkit.Tools<ToolkitValue>>>>;
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
