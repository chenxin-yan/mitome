// oxlint-disable-next-line jsdoc/check-tag-names
/** @effect-diagnostics missingEffectContext:skip-file */
import { Schema } from "effect";
import type { PluginHooks, Provider } from "@mitome/core";
import {
  defineAgent,
  definePlugin,
  tool,
  type PluginHooksDefinition,
  type ToolInputValidator,
} from "../src/index.js";

export type PublicToolInputValidator = ToolInputValidator;

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;
type ContributionsOf<Value> = Value extends import("@mitome/core").Plugin<
  infer _Resource,
  infer _Error,
  infer Contributions extends import("@mitome/core").ToolContributions
>
  ? Contributions
  : never;

const formatInputSchema = Schema.Struct({ value: Schema.Finite });
declare const model: Provider<"test", readonly []>;

export type PluginHookKeyParity = Expect<Equal<keyof PluginHooksDefinition, keyof PluginHooks>>;

const inferencePlugin = definePlugin({
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

definePlugin({
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

definePlugin({
  name: "invalid-prompt",
  tools: [],
  hooks: {
    // @ts-expect-error preStep must return the canonical Prompt type.
    preStep: async () => undefined,
  },
});

// Resource inferred from setup flows into hooks and tool handlers.
const resourceInferencePlugin = definePlugin({
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
definePlugin({
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
definePlugin({
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

definePlugin<{ readonly db: string }>({
  name: "explicit-resource-mismatch",
  tools: [
    // @ts-expect-error An explicit Plugin Resource must constrain every Tool Resource.
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
definePlugin({
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
definePlugin({
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
definePlugin({
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
definePlugin({
  name: "dispose-without-setup",
  tools: [],
  dispose: async (resource: string) => void resource,
});

type InferenceContributions = ContributionsOf<typeof inferencePlugin>;
export type InferenceContributionKeys = Expect<
  Equal<keyof InferenceContributions, "format" | "enabled">
>;
export type InferenceFormatInput = Expect<
  Equal<InferenceContributions["format"]["input"], typeof formatInputSchema.Type>
>;
export type InferenceEnabledOutput = Expect<
  Equal<InferenceContributions["enabled"]["output"], boolean>
>;
type ResourceContributions = ContributionsOf<typeof resourceInferencePlugin>;
export type ResourceContributionKeys = Expect<
  Equal<keyof ResourceContributions, "query" | "health">
>;
export type ResourceQueryInput = Expect<Equal<ResourceContributions["query"]["input"], string>>;
export type ResourceHealthOutput = Expect<
  Equal<ResourceContributions["health"]["output"], boolean>
>;
const sdkToolkitlessPlugin = definePlugin({ name: "sdk-toolkitless", tools: [] });
const sdkDefinition = defineAgent({
  providers: [model],
  model: "test/default",
  plugins: [inferencePlugin, resourceInferencePlugin, sdkToolkitlessPlugin] as const,
});
export type SdkPluginTupleIsPreserved = Expect<
  Equal<
    typeof sdkDefinition.plugins,
    readonly [typeof inferencePlugin, typeof resourceInferencePlugin, typeof sdkToolkitlessPlugin]
  >
>;
