// oxlint-disable-next-line jsdoc/check-tag-names
/** @effect-diagnostics missingEffectContext:skip-file */
import { Schema } from "effect";
import type { Model, PluginHooks } from "@mitome/core";
import {
  defineAgent,
  definePlugin,
  tool,
  type PluginHooksDefinition,
  type Tool,
} from "../src/index.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

declare const model: Model;

export type PluginHookKeyParity = Expect<Equal<keyof PluginHooksDefinition, keyof PluginHooks>>;

definePlugin({
  name: "inference",
  tools: [
    tool({
      name: "format",
      inputSchema: Schema.Struct({ value: Schema.Finite }),
      outputSchema: Schema.String,
      handler: async (input) => input.value.toFixed(0),
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
definePlugin({
  name: "resource-inference",
  tools: [
    tool({
      name: "query",
      inputSchema: Schema.String,
      outputSchema: Schema.String,
      handler: async (_input, { resource }: { resource: { readonly db: string } }) => resource.db,
    }),
  ],
  setup: async () => ({ db: "connection" }),
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

type ContributionsOf<Value> = Value extends import("@mitome/core").Plugin<
  infer _Resource,
  infer _Error,
  infer Contributions extends import("@mitome/core").ToolContributions
>
  ? Contributions
  : never;
const formatInputSchema = Schema.Struct({ value: Schema.Finite });
const formatTool = tool({
  name: "format",
  inputSchema: formatInputSchema,
  outputSchema: Schema.String,
  handler: async (input) => input.value.toFixed(0),
});
export type SdkToolName = Expect<Equal<typeof formatTool.name, "format">>;
type SdkToolIo =
  typeof formatTool extends Tool<infer Input, infer Output, infer _Resource, infer _Name>
    ? readonly [Input, Output]
    : never;
export type SdkToolIoIsPreserved = Expect<
  Equal<SdkToolIo, readonly [typeof formatInputSchema.Type, string]>
>;
const typedSdkPlugin = definePlugin({
  name: "typed-sdk",
  tools: [
    formatTool,
    tool({
      name: "enabled",
      inputSchema: Schema.String,
      outputSchema: Schema.Boolean,
      handler: async () => true,
    }),
  ],
});
type SdkContributions = ContributionsOf<typeof typedSdkPlugin>;
export type SdkContributionKeys = Expect<Equal<keyof SdkContributions, "format" | "enabled">>;
export type SdkFormatInput = Expect<
  Equal<SdkContributions["format"]["input"], typeof formatInputSchema.Type>
>;
export type SdkEnabledOutput = Expect<Equal<SdkContributions["enabled"]["output"], boolean>>;
const mixedResourcePlugin = definePlugin({
  name: "mixed-resource",
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
  setup: async () => ({ db: "connection" }),
});
type MixedContributions = ContributionsOf<typeof mixedResourcePlugin>;
export type MixedContributionKeys = Expect<Equal<keyof MixedContributions, "query" | "health">>;
export type MixedQueryInput = Expect<Equal<MixedContributions["query"]["input"], string>>;
export type MixedHealthOutput = Expect<Equal<MixedContributions["health"]["output"], boolean>>;
const sdkToolkitlessPlugin = definePlugin({ name: "sdk-toolkitless", tools: [] });
const sdkDefinition = defineAgent({
  model,
  plugins: [typedSdkPlugin, sdkToolkitlessPlugin] as const,
});
export type SdkPluginTupleIsPreserved = Expect<
  Equal<typeof sdkDefinition.plugins, readonly [typeof typedSdkPlugin, typeof sdkToolkitlessPlugin]>
>;
