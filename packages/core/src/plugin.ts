import { Context, Effect, Layer } from "effect";
import { Prompt, Tool, Toolkit } from "effect/unstable/ai";

export interface ToolHookContext {
  readonly name: string;
  readonly params: unknown;
}

export interface ToolResultHookContext extends ToolHookContext {
  readonly result: unknown;
  readonly isFailure: boolean;
}

export interface PluginHooks<Resource = never> {
  readonly sessionStart?: Effect.Effect<void, unknown, Resource>;
  readonly sessionEnd?: Effect.Effect<void, unknown, Resource>;
  readonly turnStart?: (text: string) => Effect.Effect<void, unknown, Resource>;
  readonly turnEnd?: (text: string) => Effect.Effect<void, unknown, Resource>;
  readonly stepStart?: (prompt: Prompt.Prompt) => Effect.Effect<void, unknown, Resource>;
  /** Receives the prompt used by the model, including any completed pre-Step transforms. */
  readonly stepEnd?: (prompt: Prompt.Prompt) => Effect.Effect<void, unknown, Resource>;
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
declare const PluginContributionsTypeId: unique symbol;

export interface Plugin<
  Resource = never,
  ResourceError = never,
  Contributions extends ToolContributions = EmptyToolContributions,
> {
  readonly [PluginContributionsTypeId]?: Contributions;
  readonly name: string;
  readonly instructions?: string;
  /** Required at runtime whenever hooks or handlers use a Resource; hooks run unprovided (missing-service defect) without it. */
  readonly resource?: Layer.Layer<Resource, ResourceError, never>;
  readonly toolkit?: Toolkit.Any;
  readonly handlers?: Record<
    string,
    (params: unknown) => Effect.Effect<unknown, unknown, Resource>
  >;
  /** Decodes Tool input for Hooks, approval predicates, and approval events. */
  readonly toolInputValidators?: Readonly<Record<string, ToolInputValidator>>;
  /** Revalidates post-Tool transforms; keys must name Tools in this Plugin. */
  readonly toolResultValidators?: Readonly<Record<string, ToolResultValidator>>;
  readonly hooks?: PluginHooks<Resource>;
}

/**
 * Any Plugin regardless of its Resource. Layer's ROut is contravariant while
 * hook/handler Effects are covariant in R, so no single parameterization
 * accepts every Plugin; the union's arms cover both variance directions.
 */
export type AnyPlugin = Plugin<any, unknown, any> | Plugin<never, any, any>;

type ServiceFree<Tools extends Record<string, Tool.Any>> = [
  Tool.HandlerServices<Tools[keyof Tools]> | Tool.ResultDecodingServices<Tools[keyof Tools]>,
] extends [never]
  ? unknown
  : never;

type ToolkitlessPlugin<Resource = never, ResourceError = never> = Omit<
  Plugin<Resource, ResourceError>,
  "toolkit" | "handlers" | "toolInputValidators" | "toolResultValidators"
> & {
  readonly toolkit?: undefined;
  readonly handlers?: undefined;
  readonly toolInputValidators?: undefined;
  readonly toolResultValidators?: undefined;
};

// NoInfer blocks contextual back-inference of Resource=any from AnyPlugin arrays.
export function definePlugin<Resource = never, ResourceError = never>(
  plugin: ToolkitlessPlugin<Resource, ResourceError>,
): NoInfer<Plugin<Resource, ResourceError>>;
export function definePlugin<const ToolkitValue extends Toolkit.Any>(plugin: {
  readonly name: string;
  readonly instructions?: string;
  readonly toolkit: ToolkitValue;
  readonly handlers: Toolkit.HandlersFrom<Toolkit.Tools<NoInfer<ToolkitValue>>> &
    ServiceFree<Toolkit.Tools<NoInfer<ToolkitValue>>>;
  readonly toolInputValidators?: Readonly<
    Partial<Record<keyof Toolkit.Tools<NoInfer<ToolkitValue>> & string, ToolInputValidator>>
  >;
  readonly toolResultValidators?: Readonly<
    Partial<Record<keyof Toolkit.Tools<NoInfer<ToolkitValue>> & string, ToolResultValidator>>
  >;
  readonly hooks?: PluginHooks;
}): Plugin<never, never, ToolkitContributions<Toolkit.ToolsByName<Toolkit.Tools<ToolkitValue>>>>;
// The impl return must be assignable to every overload return; only never is.
export function definePlugin(plugin: unknown): never {
  return plugin as never;
}

export type PluginContexts = ReadonlyMap<AnyPlugin, Context.Context<any>>;

export const providePlugin = <A, E>(
  plugin: AnyPlugin,
  contexts: PluginContexts,
  effect: Effect.Effect<A, E, any>,
): Effect.Effect<A, E> => {
  const context = contexts.get(plugin);
  return (context === undefined ? effect : Effect.provide(effect, context)) as Effect.Effect<A, E>;
};
