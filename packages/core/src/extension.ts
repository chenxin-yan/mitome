import { Context, Effect, Layer } from "effect";
import { Prompt, Tool, Toolkit } from "effect/unstable/ai";
import type { Response } from "effect/unstable/ai";

export interface ToolHookContext {
  readonly name: string;
  readonly params: unknown;
}

export interface ToolResultHookContext extends ToolHookContext {
  readonly result: unknown;
  readonly isFailure: boolean;
}

export interface ExtensionHooks<Resource = never> {
  readonly sessionStart?: Effect.Effect<void, unknown, Resource>;
  readonly sessionEnd?: Effect.Effect<void, unknown, Resource>;
  readonly turnStart?: (text: string) => Effect.Effect<void, unknown, Resource>;
  readonly turnEnd?: (text: string) => Effect.Effect<void, unknown, Resource>;
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
  readonly postTool?: (context: ToolResultHookContext) => Effect.Effect<unknown, unknown, Resource>;
}

export type ToolInputValidator = (input: unknown) => Effect.Effect<unknown, unknown>;
export type ToolResultValidator = (result: unknown) => Effect.Effect<unknown, unknown>;

export interface ToolContribution<Input = unknown, Output = unknown> {
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
declare const ExtensionProvidesTypeId: unique symbol;

export interface Extension<
  Resource = never,
  ResourceError = never,
  Contributions extends ToolContributions = EmptyToolContributions,
  Provides extends ReadonlyArray<Context.Key<any, any>> = readonly [],
> {
  readonly [ExtensionContributionsTypeId]?: Contributions;
  readonly [ExtensionProvidesTypeId]?: Provides;
  readonly name: string;
  readonly dependencies?: ReadonlyArray<AnyExtension> | undefined;
  readonly provides?: ReadonlyArray<Context.Key<any, any>> | undefined;
  readonly instructions?: string | undefined;
  /** Required at runtime whenever hooks or handlers use a Resource; hooks run unprovided (missing-service defect) without it. */
  readonly resource?: Layer.Layer<Resource, ResourceError, any> | undefined;
  readonly toolkit?: Toolkit.Any;
  readonly handlers?: Record<
    string,
    (params: unknown) => Effect.Effect<unknown, unknown, Resource>
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
export type AnyExtension = Extension<any, unknown, any, any> | Extension<never, any, any, any>;

type RejectAny<Value> = 0 extends 1 & Value ? never : unknown;

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
type AvailableServices<Resource, Dependencies extends ReadonlyArray<AnyExtension>> =
  | Resource
  | ProvidedServices<Dependencies>;
type ServiceCoverage<Tools extends Record<string, Tool.Any>, Services> = [
  Tool.HandlerServices<Tools[keyof Tools]> | Tool.ResultDecodingServices<Tools[keyof Tools]>,
] extends [Services]
  ? unknown
  : never;
type LayerInputCoverage<
  LayerValue extends Layer.Any,
  Dependencies extends ReadonlyArray<AnyExtension>,
> = [Layer.Services<LayerValue>] extends [ProvidedServices<Dependencies>] ? unknown : never;
type ProvidesCoverage<
  LayerValue extends Layer.Any,
  Provides extends ReadonlyArray<Context.Key<any, any>>,
> = [Context.Service.Identifier<Provides[number]>] extends [Layer.Success<LayerValue>]
  ? unknown
  : never;

type LayerExtension<
  LayerValue extends Layer.Any,
  Dependencies extends ReadonlyArray<AnyExtension>,
  Provides extends ReadonlyArray<Context.Key<any, any>>,
> = Omit<
  Extension<Layer.Success<LayerValue>, Layer.Error<LayerValue>, EmptyToolContributions, Provides>,
  "dependencies" | "provides" | "resource" | "hooks"
> & {
  readonly dependencies?: Dependencies | undefined;
  readonly provides?: Provides | undefined;
  readonly resource?: LayerValue | undefined;
  readonly hooks?:
    | ExtensionHooks<AvailableServices<NoInfer<Layer.Success<LayerValue>>, NoInfer<Dependencies>>>
    | undefined;
};

type ToolkitlessExtension<
  LayerValue extends Layer.Any,
  Dependencies extends ReadonlyArray<AnyExtension>,
  Provides extends ReadonlyArray<Context.Key<any, any>>,
> = Omit<
  LayerExtension<LayerValue, Dependencies, Provides>,
  "toolkit" | "handlers" | "toolInputValidators" | "toolResultValidators"
> & {
  readonly toolkit?: undefined;
  readonly handlers?: undefined;
  readonly toolInputValidators?: undefined;
  readonly toolResultValidators?: undefined;
};

type ResourceFreeToolkitlessExtension<Dependencies extends ReadonlyArray<AnyExtension>> = Omit<
  ToolkitlessExtension<Layer.Layer<never, never, never>, Dependencies, readonly []>,
  "resource" | "hooks"
> & {
  readonly resource?: undefined;
  readonly hooks?: ExtensionHooks<ProvidedServices<NoInfer<Dependencies>>> | undefined;
};

type ToolkitExtension<
  ToolkitValue extends Toolkit.Any,
  Dependencies extends ReadonlyArray<AnyExtension>,
> = {
  readonly name: string;
  readonly dependencies?: Dependencies | undefined;
  readonly provides?: readonly [] | undefined;
  readonly instructions?: string | undefined;
  readonly resource?: undefined;
  readonly toolkit: ToolkitValue;
  readonly handlers: Toolkit.HandlersFrom<Toolkit.Tools<NoInfer<ToolkitValue>>> &
    ServiceCoverage<Toolkit.Tools<NoInfer<ToolkitValue>>, ProvidedServices<NoInfer<Dependencies>>>;
  readonly toolInputValidators?: Readonly<
    Partial<Record<keyof Toolkit.Tools<NoInfer<ToolkitValue>> & string, ToolInputValidator>>
  >;
  readonly toolResultValidators?: Readonly<
    Partial<Record<keyof Toolkit.Tools<NoInfer<ToolkitValue>> & string, ToolResultValidator>>
  >;
  readonly hooks?: ExtensionHooks<ProvidedServices<NoInfer<Dependencies>>> | undefined;
};

type ResourcefulToolkitExtension<
  LayerValue extends Layer.Any,
  ToolkitValue extends Toolkit.Any,
  Dependencies extends ReadonlyArray<AnyExtension>,
  Provides extends ReadonlyArray<Context.Key<any, any>>,
> = Omit<
  LayerExtension<LayerValue, Dependencies, Provides>,
  "resource" | "toolkit" | "handlers" | "toolInputValidators" | "toolResultValidators" | "hooks"
> & {
  readonly resource: LayerValue;
  readonly toolkit: ToolkitValue;
  readonly handlers: Toolkit.HandlersFrom<Toolkit.Tools<NoInfer<ToolkitValue>>> &
    ServiceCoverage<
      Toolkit.Tools<NoInfer<ToolkitValue>>,
      AvailableServices<Layer.Success<NoInfer<LayerValue>>, NoInfer<Dependencies>>
    >;
  readonly toolInputValidators?: Readonly<
    Partial<Record<keyof Toolkit.Tools<NoInfer<ToolkitValue>> & string, ToolInputValidator>>
  >;
  readonly toolResultValidators?: Readonly<
    Partial<Record<keyof Toolkit.Tools<NoInfer<ToolkitValue>> & string, ToolResultValidator>>
  >;
  readonly hooks?:
    | ExtensionHooks<AvailableServices<Layer.Success<NoInfer<LayerValue>>, NoInfer<Dependencies>>>
    | undefined;
};

// NoInfer blocks contextual back-inference of Resource=any from AnyExtension arrays.
export function defineExtension<const LayerValue extends Layer.Layer<any, any, never>>(
  extension: ToolkitlessExtension<LayerValue, readonly [], readonly []> & {
    readonly resource: LayerValue;
  } & RejectAny<LayerValue>,
): NoInfer<Extension<Layer.Success<LayerValue>, Layer.Error<LayerValue>>>;
export function defineExtension<
  const LayerValue extends Layer.Any,
  const Dependencies extends ReadonlyArray<AnyExtension> = readonly [],
  const Provides extends ReadonlyArray<Context.Key<any, any>> = readonly [],
>(
  extension: ToolkitlessExtension<LayerValue, Dependencies, Provides> & {
    readonly resource: LayerValue;
  } & ({ readonly dependencies: Dependencies } | { readonly provides: Provides }) &
    RejectAny<LayerValue> &
    LayerInputCoverage<LayerValue, NoInfer<Dependencies>> &
    ProvidesCoverage<NoInfer<LayerValue>, Provides>,
): NoInfer<
  Extension<Layer.Success<LayerValue>, Layer.Error<LayerValue>, EmptyToolContributions, Provides>
>;
export function defineExtension<
  const Dependencies extends ReadonlyArray<AnyExtension> = readonly [],
>(
  extension: ResourceFreeToolkitlessExtension<Dependencies>,
): NoInfer<Extension<never, never, EmptyToolContributions, readonly []>>;
export function defineExtension<
  const ToolkitValue extends Toolkit.Any,
  const Dependencies extends ReadonlyArray<AnyExtension> = readonly [],
>(
  extension: ToolkitExtension<ToolkitValue, Dependencies>,
): Extension<
  never,
  never,
  ToolkitContributions<Toolkit.ToolsByName<Toolkit.Tools<ToolkitValue>>>,
  readonly []
>;
export function defineExtension<
  const LayerValue extends Layer.Layer<any, any, never>,
  const ToolkitValue extends Toolkit.Any,
>(
  extension: ResourcefulToolkitExtension<LayerValue, ToolkitValue, readonly [], readonly []> &
    RejectAny<LayerValue>,
): Extension<
  Layer.Success<LayerValue>,
  Layer.Error<LayerValue>,
  ToolkitContributions<Toolkit.ToolsByName<Toolkit.Tools<ToolkitValue>>>
>;
export function defineExtension<
  const LayerValue extends Layer.Any,
  const ToolkitValue extends Toolkit.Any,
  const Dependencies extends ReadonlyArray<AnyExtension> = readonly [],
  const Provides extends ReadonlyArray<Context.Key<any, any>> = readonly [],
>(
  extension: ResourcefulToolkitExtension<LayerValue, ToolkitValue, Dependencies, Provides> &
    ({ readonly dependencies: Dependencies } | { readonly provides: Provides }) &
    RejectAny<LayerValue> &
    LayerInputCoverage<LayerValue, NoInfer<Dependencies>> &
    ProvidesCoverage<NoInfer<LayerValue>, Provides>,
): Extension<
  Layer.Success<LayerValue>,
  Layer.Error<LayerValue>,
  ToolkitContributions<Toolkit.ToolsByName<Toolkit.Tools<ToolkitValue>>>,
  Provides
>;
// The impl return must be assignable to every overload return; only never is.
export function defineExtension(extension: unknown): never {
  return extension as never;
}

export type ExtensionContexts = ReadonlyMap<AnyExtension, Context.Context<any>>;

export const provideExtension = <A, E>(
  extension: AnyExtension,
  contexts: ExtensionContexts,
  effect: Effect.Effect<A, E, any>,
): Effect.Effect<A, E> => {
  const context = contexts.get(extension);
  return (context === undefined ? effect : Effect.provide(effect, context)) as Effect.Effect<A, E>;
};

export const provideExtensionHook = <A, E>(
  extension: AnyExtension,
  contexts: ExtensionContexts,
  effect: Effect.Effect<A, E, any> | undefined,
): Effect.Effect<A, E> | undefined =>
  effect === undefined ? undefined : provideExtension(extension, contexts, effect);
