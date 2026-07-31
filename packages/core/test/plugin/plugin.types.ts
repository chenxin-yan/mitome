// oxlint-disable-next-line jsdoc/check-tag-names
/** @effect-diagnostics missingEffectContext:skip-file */
import { Context, Effect, Layer, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import {
  defineAgent,
  definePlugin,
  type AgentDefinition,
  type AnyPlugin,
  type Plugin,
  type Provider,
  type ToolContribution,
} from "../../src/index.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;
type ContributionsOf<Value> =
  Value extends Plugin<infer _Resource, infer _Error, infer Contributions> ? Contributions : never;
type ResourceOf<Value> =
  Value extends Plugin<infer Resource, infer _Error, infer _Contributions> ? Resource : never;
type ResourceErrorOf<Value> =
  Value extends Plugin<infer _Resource, infer ResourceError, infer _Contributions>
    ? ResourceError
    : never;

declare const model: Provider<"test", readonly []>;

class Dependency extends Context.Service<Dependency, { readonly value: string }>()(
  "@mitome/core/test/Dependency",
) {}

const independent = Tool.make("independent");
const typedCorePlugin = definePlugin({
  name: "typed-core",
  toolkit: Toolkit.make(
    Tool.make("count", {
      parameters: Schema.Struct({ amount: Schema.Finite }),
      success: Schema.String,
    }),
    Tool.make("label", { parameters: Schema.String, success: Schema.Boolean }),
  ),
  handlers: {
    count: () => Effect.succeed("done"),
    label: () => Effect.succeed(true),
  },
});
type TypedCoreContributions = ContributionsOf<typeof typedCorePlugin>;
export type CoreContributionKeys = Expect<Equal<keyof TypedCoreContributions, "count" | "label">>;
export type CoreCountInput = Expect<
  Equal<TypedCoreContributions["count"]["input"], { readonly amount: number }>
>;
export type CoreLabelOutput = Expect<Equal<TypedCoreContributions["label"]["output"], boolean>>;

definePlugin({
  name: "independent",
  toolkit: Toolkit.make(independent),
  handlers: { independent: () => Effect.void },
});

definePlugin({
  name: "wrong-handler",
  toolkit: Toolkit.make(independent),
  // @ts-expect-error Toolkit handlers must use the Tool's exact name.
  handlers: { wrong: () => Effect.void },
});

// @ts-expect-error A Toolkit requiring a handler cannot omit it.
definePlugin({ name: "missing-handler", toolkit: Toolkit.make(independent), handlers: {} });

const dependent = Tool.make("dependent", { dependencies: [Dependency] });
definePlugin({
  name: "dependent",
  toolkit: Toolkit.make(dependent),
  // @ts-expect-error Tool service dependencies require a Plugin resource Layer.
  handlers: { dependent: () => Effect.map(Dependency, ({ value }) => value) },
});

// AnyPlugin must accept every Plugin parameterization; Layer's contravariant
// ROut vs covariant hook R means neither union arm alone suffices.
declare const resourceful: Plugin<{ readonly db: string }, Error>;
declare const unknownResource: Plugin<unknown, never>;
declare const bare: Plugin;
export const anyPlugins: ReadonlyArray<AnyPlugin> = [resourceful, unknownResource, bare];

const PluginResource = Context.Service<string>("@mitome/core/test/PluginResource");
const AdditionalPluginResource = Context.Service<number>(
  "@mitome/core/test/AdditionalPluginResource",
);
const MissingPluginResource = Context.Service<boolean>("@mitome/core/test/MissingPluginResource");

export const resourcePlugin = definePlugin({
  name: "resourceful",
  resource: Layer.succeed(PluginResource, "value"),
  hooks: { sessionStart: Effect.asVoid(Effect.service(PluginResource)) },
});
export type InferredPluginResource = Expect<Equal<ResourceOf<typeof resourcePlugin>, string>>;
export type InferredPluginResourceError = Expect<
  Equal<ResourceErrorOf<typeof resourcePlugin>, never>
>;

const mergedResourcePlugin = definePlugin({
  name: "merged-resourceful",
  resource: Layer.mergeAll(
    Layer.succeed(PluginResource, "value"),
    Layer.succeed(AdditionalPluginResource, 1),
  ),
  hooks: {
    sessionStart: Effect.asVoid(Effect.service(PluginResource)),
    sessionEnd: Effect.asVoid(Effect.service(AdditionalPluginResource)),
  },
});
export type InferredMergedPluginResource = Expect<
  Equal<ResourceOf<typeof mergedResourcePlugin>, string | number>
>;

// @ts-expect-error Hooks may only require services supplied by the resource Layer.
definePlugin({
  name: "missing-resource",
  resource: Layer.succeed(PluginResource, "value"),
  hooks: { sessionStart: Effect.asVoid(Effect.service(MissingPluginResource)) },
});

definePlugin<any>({
  name: "explicit-resource-escape",
  // @ts-expect-error Explicit generics cannot widen the resource Layer's output.
  resource: Layer.succeed(PluginResource, "value"),
  // @ts-expect-error Explicit generics cannot widen the resource Layer's output.
  hooks: { sessionStart: Effect.asVoid(Effect.service(MissingPluginResource)) },
});

class ResourceFailure {}
const failingResourcePlugin = definePlugin({
  name: "failing-resource",
  resource: Layer.effect(PluginResource, Effect.fail(new ResourceFailure())),
});
export type InferredPluginResourceFailure = Expect<
  Equal<ResourceErrorOf<typeof failingResourcePlugin>, ResourceFailure>
>;

const resourceFreePlugin = definePlugin({ name: "resource-free" });
export type InferredResourceFreePluginResource = Expect<
  Equal<ResourceOf<typeof resourceFreePlugin>, never>
>;

definePlugin({
  name: "explicit-undefined",
  instructions: undefined,
  resource: undefined,
  hooks: undefined,
});

declare const decodingDependentSchema: Schema.Codec<string, string, Dependency, never>;
const decodingDependent = Tool.make("decoding-dependent", {
  success: decodingDependentSchema,
});
definePlugin({
  name: "decoding-dependent",
  toolkit: Toolkit.make(decodingDependent),
  // @ts-expect-error Tool result decoding services require a Plugin resource Layer.
  handlers: { "decoding-dependent": () => Effect.succeed("result") },
});

const resourcefulDependent = Tool.make("resourceful-dependent", {
  dependencies: [Dependency],
  parameters: Schema.Struct({ amount: Schema.Finite }),
  success: decodingDependentSchema,
});
const resourcefulToolkitPlugin = definePlugin({
  name: "resourceful-toolkit",
  resource: Layer.succeed(Dependency, { value: "resource" }),
  toolkit: Toolkit.make(resourcefulDependent),
  handlers: {
    "resourceful-dependent": (params) => {
      const amount: number = params.amount;
      return Effect.map(Dependency, ({ value }) => `${value}:${amount}`);
    },
  },
  hooks: { sessionStart: Effect.asVoid(Dependency) },
});
type ResourcefulToolkitContributions = ContributionsOf<typeof resourcefulToolkitPlugin>;
export type ResourcefulToolkitResource = Expect<
  Equal<ResourceOf<typeof resourcefulToolkitPlugin>, Dependency>
>;
export type ResourcefulToolkitContribution = Expect<
  Equal<
    ResourcefulToolkitContributions["resourceful-dependent"],
    ToolContribution<{ readonly amount: number }, string>
  >
>;

const uncoveredHandler = Tool.make("uncovered-handler", { dependencies: [MissingPluginResource] });
definePlugin({
  name: "uncovered-handler",
  resource: Layer.succeed(Dependency, { value: "resource" }),
  toolkit: Toolkit.make(uncoveredHandler),
  // @ts-expect-error Tool handler services must be supplied by the resource Layer.
  handlers: { "uncovered-handler": () => Effect.asVoid(MissingPluginResource) },
});

declare const missingDecodingSchema: Schema.Codec<
  string,
  string,
  typeof MissingPluginResource,
  never
>;
const uncoveredDecoding = Tool.make("uncovered-decoding", { success: missingDecodingSchema });
definePlugin({
  name: "uncovered-decoding",
  resource: Layer.succeed(Dependency, { value: "resource" }),
  toolkit: Toolkit.make(uncoveredDecoding),
  // @ts-expect-error Tool result decoding services must be supplied by the resource Layer.
  handlers: { "uncovered-decoding": () => Effect.succeed("result") },
});

definePlugin({
  name: "uncovered-toolkit-hook",
  resource: Layer.succeed(Dependency, { value: "resource" }),
  toolkit: Toolkit.make(independent),
  handlers: { independent: () => Effect.void },
  // @ts-expect-error Hooks must only require services supplied by the resource Layer.
  hooks: { sessionStart: Effect.asVoid(MissingPluginResource) },
});

const toolkitlessPlugin = definePlugin({ name: "toolkitless" });
const typedDefinition = defineAgent({
  providers: [model],
  model: "test/default",
  plugins: [typedCorePlugin, toolkitlessPlugin, resourcePlugin] as const,
});
export type PreservedPluginTuple = Expect<
  Equal<
    typeof typedDefinition.plugins,
    readonly [typeof typedCorePlugin, typeof toolkitlessPlugin, typeof resourcePlugin]
  >
>;
const heterogeneousPlugins: ReadonlyArray<AnyPlugin> = [
  typedCorePlugin,
  toolkitlessPlugin,
  resourcePlugin,
];
const heterogeneousDefinition: AgentDefinition<
  readonly [typeof model],
  "test/default",
  readonly [typeof typedCorePlugin, typeof toolkitlessPlugin, typeof resourcePlugin]
> = typedDefinition;
const explicitlyTypedDefinition = defineAgent<readonly [typeof model], "test/default", readonly []>(
  {
    providers: [model],
    model: "test/default",
    plugins: [],
  },
);
void heterogeneousPlugins;
void heterogeneousDefinition;
void explicitlyTypedDefinition;
