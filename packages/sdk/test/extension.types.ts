// oxlint-disable-next-line jsdoc/check-tag-names
/** @effect-diagnostics missingEffectContext:skip-file */
import { Context, Effect, Layer, Schema } from "effect";
import type { ExtensionHooks, Provider } from "@mitome/core";
import { defineExtension as defineEffectExtension } from "../src/effect.js";
import {
  defineAgent,
  defineExtension,
  tool,
  type ExtensionHooksDefinition,
  type ToolInputValidator,
} from "../src/index.js";

export type PublicToolInputValidator = ToolInputValidator;

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;
type ContributionsOf<Value> = Value extends import("@mitome/core").Extension<
  infer _Resource,
  infer _Error,
  infer Contributions extends import("@mitome/core").ToolContributions
>
  ? Contributions
  : never;
type ProvidesOf<Value> = Value extends import("@mitome/core").Extension<
  any,
  any,
  any,
  infer Provides extends ReadonlyArray<Context.Service.Any>
>
  ? Provides
  : never;

const formatInputSchema = Schema.Struct({ value: Schema.Finite });
declare const model: Provider<"test", readonly []>;

export type ExtensionHookKeyParity = Expect<
  Equal<keyof ExtensionHooksDefinition, keyof ExtensionHooks>
>;

const inferenceExtension = defineExtension({
  name: "inference",
  tools: [
    tool({
      name: "format",
      inputSchema: formatInputSchema,
      outputSchema: Schema.String,
      handler: async (input) => input.value.toFixed(0),
    }),
    tool({
      name: "enabled",
      inputSchema: Schema.String,
      outputSchema: Schema.Boolean,
      handler: async () => true,
    }),
  ],
  hooks: {
    stepStart: async (prompt) => {
      void prompt.content;
    },
    preStep: async (prompt) => prompt,
  },
});

defineExtension({
  name: "invalid-output",
  tools: [
    tool({
      name: "invalid",
      inputSchema: Schema.String,
      outputSchema: Schema.String,
      // @ts-expect-error Handler output must match the output Schema.
      handler: async () => 1,
    }),
  ],
});

defineExtension({
  name: "invalid-prompt",
  tools: [],
  hooks: {
    // @ts-expect-error preStep must return the canonical Prompt type.
    preStep: async () => undefined,
  },
});

// Resource inferred from setup flows into hooks and tool handlers.
const resourceInferenceExtension = defineExtension({
  name: "resource-inference",
  tools: [
    tool({
      name: "query",
      inputSchema: Schema.String,
      outputSchema: Schema.String,
      handler: async (_input, { resource }: { resource: { readonly db: string } }) => resource.db,
    }),
    tool({
      name: "health",
      inputSchema: Schema.String,
      outputSchema: Schema.Boolean,
      handler: async () => true,
    }),
  ],
  setup: async () => ({ db: "connection", cache: 1 }),
  hooks: {
    sessionStart: async ({ resource }) => {
      const db: string = resource.db;
      void db;
    },
  },
});

// @ts-expect-error Tools declaring a Resource require setup.
defineExtension({
  name: "resource-without-setup",
  tools: [
    tool<string, string, { readonly db: string }>({
      name: "orphan",
      inputSchema: Schema.String,
      outputSchema: Schema.String,
      handler: async (_input, { resource }) => resource.db,
    }),
  ],
});

// @ts-expect-error Tool Resource must match setup Resource.
defineExtension({
  name: "resource-mismatch",
  tools: [
    tool<string, string, { readonly db: string }>({
      name: "query",
      inputSchema: Schema.String,
      outputSchema: Schema.String,
      handler: async (_input, { resource }) => resource.db,
    }),
  ],
  setup: async () => ({ cache: 1 }),
});

defineExtension<{ readonly db: string }>({
  name: "explicit-resource-mismatch",
  tools: [
    // @ts-expect-error An explicit Extension Resource must constrain every Tool Resource.
    tool<string, string, { readonly cache: number }>({
      name: "cache",
      inputSchema: Schema.String,
      outputSchema: Schema.String,
      handler: async (_input, { resource }) => String(resource.cache),
    }),
  ],
  setup: async () => ({ db: "connection" }),
});

// @ts-expect-error Setup Resource must satisfy every Tool Resource.
defineExtension({
  name: "partial-resource",
  tools: [
    tool<string, string, { readonly db: string }>({
      name: "query",
      inputSchema: Schema.String,
      outputSchema: Schema.String,
      handler: async (_input, { resource }) => resource.db,
    }),
    tool<string, string, { readonly cache: number }>({
      name: "cache",
      inputSchema: Schema.String,
      outputSchema: Schema.String,
      handler: async (_input, { resource }) => String(resource.cache),
    }),
  ],
  setup: async () => ({ db: "connection" }),
});

// @ts-expect-error A Resource with optional fields cannot satisfy a Tool requiring them.
defineExtension({
  name: "optional-resource",
  tools: [
    tool<string, string, { readonly db: string }>({
      name: "query",
      inputSchema: Schema.String,
      outputSchema: Schema.String,
      handler: async (_input, { resource }) => resource.db,
    }),
  ],
  setup: async (): Promise<{ readonly db?: string }> => ({}),
});

// @ts-expect-error Any Tool Resource requires setup, including mixed Tool tuples.
defineExtension({
  name: "mixed-without-setup",
  tools: [
    tool<string, string, { readonly db: string }>({
      name: "query",
      inputSchema: Schema.String,
      outputSchema: Schema.String,
      handler: async (_input, { resource }) => resource.db,
    }),
    tool({
      name: "health",
      inputSchema: Schema.String,
      outputSchema: Schema.Boolean,
      handler: async () => true,
    }),
  ],
});

// @ts-expect-error dispose requires setup.
defineExtension({
  name: "dispose-without-setup",
  tools: [],
  dispose: async (resource: string) => void resource,
});

type InferenceContributions = ContributionsOf<typeof inferenceExtension>;
export type InferenceContributionKeys = Expect<
  Equal<keyof InferenceContributions, "format" | "enabled">
>;
export type InferenceFormatInput = Expect<
  Equal<InferenceContributions["format"]["input"], typeof formatInputSchema.Type>
>;
export type InferenceEnabledOutput = Expect<
  Equal<InferenceContributions["enabled"]["output"], boolean>
>;
type ResourceContributions = ContributionsOf<typeof resourceInferenceExtension>;
export type ResourceContributionKeys = Expect<
  Equal<keyof ResourceContributions, "query" | "health">
>;
export type ResourceQueryInput = Expect<Equal<ResourceContributions["query"]["input"], string>>;
export type ResourceHealthOutput = Expect<
  Equal<ResourceContributions["health"]["output"], boolean>
>;
const sdkToolkitlessExtension = defineExtension({ name: "sdk-toolkitless", tools: [] });
const sdkDefinition = defineAgent({
  providers: [model],
  model: "test/default",
  extensions: [inferenceExtension, resourceInferenceExtension, sdkToolkitlessExtension] as const,
});
export type SdkExtensionTupleIsPreserved = Expect<
  Equal<
    typeof sdkDefinition.extensions,
    readonly [
      typeof inferenceExtension,
      typeof resourceInferenceExtension,
      typeof sdkToolkitlessExtension,
    ]
  >
>;

class EffectService extends Context.Service<EffectService, { readonly value: string }>()(
  "@mitome/sdk/test/EffectService",
) {}
class SdkService extends Context.Service<SdkService, { readonly count: number }>()(
  "@mitome/sdk/test/SdkService",
) {}
class MissingService extends Context.Service<MissingService, { readonly missing: true }>()(
  "@mitome/sdk/test/MissingService",
) {}

const effectServiceLayer = Layer.succeed(EffectService, { value: "effect" });
const effectProvider = defineEffectExtension<
  typeof effectServiceLayer,
  readonly [],
  readonly [typeof EffectService]
>({
  name: "effect-provider",
  resource: effectServiceLayer,
  provides: [EffectService],
});

defineExtension({
  name: "sdk-effect-dependent",
  dependencies: [effectProvider],
  tools: [
    tool({
      name: "read-effect-service",
      dependencies: [EffectService],
      inputSchema: Schema.String,
      outputSchema: Schema.String,
      handler: async (_input, { getService }) => {
        const value: string = getService(EffectService).value;
        return value;
      },
    }),
  ],
  hooks: {
    sessionStart: async ({ getService }) => {
      const value: string = getService(EffectService).value;
      void value;
      // @ts-expect-error Hooks cannot access services not provided by declared dependencies.
      getService(MissingService);
    },
  },
});

const uncoveredTool = tool({
  name: "uncovered-service",
  dependencies: [MissingService],
  inputSchema: Schema.String,
  outputSchema: Schema.String,
  handler: async (_input, { getService }) => String(getService(MissingService).missing),
});

// @ts-expect-error Tool service dependencies must be provided by an Extension dependency.
defineExtension({
  name: "uncovered-tool-service",
  dependencies: [effectProvider],
  tools: [uncoveredTool],
});

const sdkProvider = defineExtension({
  name: "sdk-provider",
  provides: [SdkService],
  tools: [],
  setup: async () => ({ count: 1 }),
});
export type SdkProvidedServicesAreInferred = Expect<
  Equal<ProvidesOf<typeof sdkProvider>, readonly [typeof SdkService]>
>;

defineEffectExtension({
  name: "effect-sdk-dependent",
  dependencies: [sdkProvider],
  hooks: { sessionStart: Effect.asVoid(SdkService) },
});

// @ts-expect-error setup must implement the intersection of all published service Tags.
defineExtension({
  name: "invalid-sdk-provider",
  provides: [SdkService, EffectService],
  tools: [],
  setup: async () => ({ count: 1 }),
});
