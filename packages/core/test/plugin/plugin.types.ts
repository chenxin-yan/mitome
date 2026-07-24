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
} from "../../src/index.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;
type ContributionsOf<Value> =
  Value extends Plugin<infer _Resource, infer _Error, infer Contributions> ? Contributions : never;

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
export const resourcePlugin: Plugin<string> = definePlugin({
  name: "resourceful",
  resource: Layer.succeed(PluginResource, "value"),
  hooks: { sessionStart: Effect.asVoid(Effect.service(PluginResource)) },
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
