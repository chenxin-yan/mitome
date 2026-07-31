// oxlint-disable-next-line jsdoc/check-tag-names
/** @effect-diagnostics missingEffectContext:skip-file */
import { Context, Effect, Layer, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import {
  defineAgent,
  defineExtension,
  type AgentDefinition,
  type AnyExtension,
  type Extension,
  type Provider,
  type ToolContribution,
} from "../../src/index.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;
type ContributionsOf<Value> =
  Value extends Extension<infer _Resource, infer _Error, infer Contributions>
    ? Contributions
    : never;
type ResourceOf<Value> =
  Value extends Extension<infer Resource, infer _Error, infer _Contributions> ? Resource : never;
type ResourceErrorOf<Value> =
  Value extends Extension<infer _Resource, infer ResourceError, infer _Contributions>
    ? ResourceError
    : never;

declare const model: Provider<"test", readonly []>;

class Dependency extends Context.Service<Dependency, { readonly value: string }>()(
  "@mitome/core/test/Dependency",
) {}

const independent = Tool.make("independent");
const typedCoreExtension = defineExtension({
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
type TypedCoreContributions = ContributionsOf<typeof typedCoreExtension>;
export type CoreContributionKeys = Expect<Equal<keyof TypedCoreContributions, "count" | "label">>;
export type CoreCountInput = Expect<
  Equal<TypedCoreContributions["count"]["input"], { readonly amount: number }>
>;
export type CoreLabelOutput = Expect<Equal<TypedCoreContributions["label"]["output"], boolean>>;

defineExtension({
  name: "independent",
  toolkit: Toolkit.make(independent),
  handlers: { independent: () => Effect.void },
});

defineExtension({
  name: "wrong-handler",
  toolkit: Toolkit.make(independent),
  // @ts-expect-error Toolkit handlers must use the Tool's exact name.
  handlers: { wrong: () => Effect.void },
});

// @ts-expect-error A Toolkit requiring a handler cannot omit it.
defineExtension({ name: "missing-handler", toolkit: Toolkit.make(independent), handlers: {} });

const dependent = Tool.make("dependent", { dependencies: [Dependency] });
defineExtension({
  name: "dependent",
  toolkit: Toolkit.make(dependent),
  // @ts-expect-error Tool service dependencies require an Extension resource Layer.
  handlers: { dependent: () => Effect.map(Dependency, ({ value }) => value) },
});

// AnyExtension must accept every Extension parameterization; Layer's contravariant
// ROut vs covariant hook R means neither union arm alone suffices.
declare const resourceful: Extension<{ readonly db: string }, Error>;
declare const unknownResource: Extension<unknown, never>;
declare const bare: Extension;
export const anyExtensions: ReadonlyArray<AnyExtension> = [resourceful, unknownResource, bare];

const ExtensionResource = Context.Service<string>("@mitome/core/test/ExtensionResource");
const AdditionalExtensionResource = Context.Service<number>(
  "@mitome/core/test/AdditionalExtensionResource",
);
const MissingExtensionResource = Context.Service<boolean>(
  "@mitome/core/test/MissingExtensionResource",
);

export const resourceExtension = defineExtension({
  name: "resourceful",
  resource: Layer.succeed(ExtensionResource, "value"),
  hooks: { sessionStart: Effect.asVoid(Effect.service(ExtensionResource)) },
});
export type InferredExtensionResource = Expect<Equal<ResourceOf<typeof resourceExtension>, string>>;
export type InferredExtensionResourceError = Expect<
  Equal<ResourceErrorOf<typeof resourceExtension>, never>
>;

const mergedResourceExtension = defineExtension({
  name: "merged-resourceful",
  resource: Layer.mergeAll(
    Layer.succeed(ExtensionResource, "value"),
    Layer.succeed(AdditionalExtensionResource, 1),
  ),
  hooks: {
    sessionStart: Effect.asVoid(Effect.service(ExtensionResource)),
    sessionEnd: Effect.asVoid(Effect.service(AdditionalExtensionResource)),
  },
});
export type InferredMergedExtensionResource = Expect<
  Equal<ResourceOf<typeof mergedResourceExtension>, string | number>
>;

// @ts-expect-error Hooks may only require services supplied by the resource Layer.
defineExtension({
  name: "missing-resource",
  resource: Layer.succeed(ExtensionResource, "value"),
  hooks: { sessionStart: Effect.asVoid(Effect.service(MissingExtensionResource)) },
});

defineExtension<any>({
  name: "explicit-resource-escape",
  // @ts-expect-error Explicit generics cannot widen the resource Layer's output.
  resource: Layer.succeed(ExtensionResource, "value"),
  // @ts-expect-error Explicit generics cannot widen the resource Layer's output.
  hooks: { sessionStart: Effect.asVoid(Effect.service(MissingExtensionResource)) },
});

class ResourceFailure {}
const failingResourceExtension = defineExtension({
  name: "failing-resource",
  resource: Layer.effect(ExtensionResource, Effect.fail(new ResourceFailure())),
});
export type InferredExtensionResourceFailure = Expect<
  Equal<ResourceErrorOf<typeof failingResourceExtension>, ResourceFailure>
>;

const resourceFreeExtension = defineExtension({ name: "resource-free" });
export type InferredResourceFreeExtensionResource = Expect<
  Equal<ResourceOf<typeof resourceFreeExtension>, never>
>;

defineExtension({
  name: "explicit-undefined",
  instructions: undefined,
  resource: undefined,
  hooks: undefined,
});

declare const decodingDependentSchema: Schema.Codec<string, string, Dependency, never>;
const decodingDependent = Tool.make("decoding-dependent", {
  success: decodingDependentSchema,
});
defineExtension({
  name: "decoding-dependent",
  toolkit: Toolkit.make(decodingDependent),
  // @ts-expect-error Tool result decoding services require an Extension resource Layer.
  handlers: { "decoding-dependent": () => Effect.succeed("result") },
});

const resourcefulDependent = Tool.make("resourceful-dependent", {
  dependencies: [Dependency],
  parameters: Schema.Struct({ amount: Schema.Finite }),
  success: decodingDependentSchema,
});
const resourcefulToolkitExtension = defineExtension({
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
type ResourcefulToolkitContributions = ContributionsOf<typeof resourcefulToolkitExtension>;
export type ResourcefulToolkitResource = Expect<
  Equal<ResourceOf<typeof resourcefulToolkitExtension>, Dependency>
>;
export type ResourcefulToolkitContribution = Expect<
  Equal<
    ResourcefulToolkitContributions["resourceful-dependent"],
    ToolContribution<{ readonly amount: number }, string>
  >
>;

const uncoveredHandler = Tool.make("uncovered-handler", {
  dependencies: [MissingExtensionResource],
});
defineExtension({
  name: "uncovered-handler",
  resource: Layer.succeed(Dependency, { value: "resource" }),
  toolkit: Toolkit.make(uncoveredHandler),
  // @ts-expect-error Tool handler services must be supplied by the resource Layer.
  handlers: { "uncovered-handler": () => Effect.asVoid(MissingExtensionResource) },
});

declare const missingDecodingSchema: Schema.Codec<
  string,
  string,
  typeof MissingExtensionResource,
  never
>;
const uncoveredDecoding = Tool.make("uncovered-decoding", { success: missingDecodingSchema });
defineExtension({
  name: "uncovered-decoding",
  resource: Layer.succeed(Dependency, { value: "resource" }),
  toolkit: Toolkit.make(uncoveredDecoding),
  // @ts-expect-error Tool result decoding services must be supplied by the resource Layer.
  handlers: { "uncovered-decoding": () => Effect.succeed("result") },
});

defineExtension({
  name: "uncovered-toolkit-hook",
  resource: Layer.succeed(Dependency, { value: "resource" }),
  toolkit: Toolkit.make(independent),
  handlers: { independent: () => Effect.void },
  // @ts-expect-error Hooks must only require services supplied by the resource Layer.
  hooks: { sessionStart: Effect.asVoid(MissingExtensionResource) },
});

const toolkitlessExtension = defineExtension({ name: "toolkitless" });
const typedDefinition = defineAgent({
  providers: [model],
  model: "test/default",
  extensions: [typedCoreExtension, toolkitlessExtension, resourceExtension] as const,
});
export type PreservedExtensionTuple = Expect<
  Equal<
    typeof typedDefinition.extensions,
    readonly [typeof typedCoreExtension, typeof toolkitlessExtension, typeof resourceExtension]
  >
>;
const heterogeneousExtensions: ReadonlyArray<AnyExtension> = [
  typedCoreExtension,
  toolkitlessExtension,
  resourceExtension,
];
const heterogeneousDefinition: AgentDefinition<
  readonly [typeof model],
  "test/default",
  readonly [typeof typedCoreExtension, typeof toolkitlessExtension, typeof resourceExtension]
> = typedDefinition;
const explicitlyTypedDefinition = defineAgent<readonly [typeof model], "test/default", readonly []>(
  {
    providers: [model],
    model: "test/default",
    extensions: [],
  },
);
void heterogeneousExtensions;
void heterogeneousDefinition;
void explicitlyTypedDefinition;
