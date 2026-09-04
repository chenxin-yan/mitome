// oxlint-disable-next-line jsdoc/check-tag-names
/** @effect-diagnostics missingEffectContext:skip-file */
import { Schema } from "effect";
import type { ExtensionHooks, Provider } from "@mitome/core";
import {
  defineAgent,
  defineExtension,
  fail,
  ok,
  type ExtensionHooksDefinition,
  type ToolBuilder,
  type ToolInputValidator,
  type ModelPrompt,
} from "../src/index.js";

export type PublicToolInputValidator = ToolInputValidator;
export type PublicModelPrompt = ModelPrompt;

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

const formatInputSchema = Schema.Struct({ value: Schema.Finite });
declare const model: Provider<"test", readonly []>;

export type ExtensionHookKeyParity = Expect<
  Equal<keyof ExtensionHooksDefinition, keyof ExtensionHooks>
>;

const inferenceExtension = defineExtension({
  name: "inference",
  tools: ({ tool }) => [
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
  tools: ({ tool }) => [
    tool({
      name: "invalid",
      inputSchema: Schema.String,
      // @ts-expect-error Handler output must match the output Schema.
      outputSchema: Schema.String,
      handler: async () => 1,
    }),
  ],
});

defineExtension({
  name: "invalid-prompt",
  hooks: {
    // @ts-expect-error preStep must return the canonical Model Prompt type.
    preStep: async () => undefined,
  },
});

// Resource inferred from setup flows into hooks and tool handlers.
const resourceInferenceExtension = defineExtension({
  name: "resource-inference",
  tools: ({ tool }) => [
    tool({
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
  setup: async () => ({ db: "connection", cache: 1 }),
  hooks: {
    sessionStart: async ({ resource }) => {
      const db: string = resource.db;
      void db;
    },
  },
});

defineExtension<{ readonly db: string }>({
  name: "explicit-resource",
  tools: ({ tool }) => [
    tool({
      name: "query",
      inputSchema: Schema.String,
      outputSchema: Schema.String,
      handler: async (_input, { resource }) => resource.db,
    }),
  ],
  setup: async () => ({ db: "connection" }),
});

defineExtension<{ readonly db: string }>({
  name: "explicit-resource-mismatch",
  tools: ({ tool }) => [
    tool({
      name: "cache",
      inputSchema: Schema.String,
      outputSchema: Schema.String,
      // @ts-expect-error The scoped builder exposes only the Extension Resource.
      handler: async (_input, { resource }) => String(resource.cache),
    }),
  ],
  setup: async () => ({ db: "connection" }),
});

// @ts-expect-error dispose requires setup.
defineExtension({
  name: "dispose-without-setup",
  dispose: async (resource: string) => void resource,
});

const inferredOutputExtension = defineExtension({
  name: "inferred-output",
  tools: ({ tool }) => [
    tool({
      name: "list",
      inputSchema: Schema.Void,
      handler: async () => ["a", "b"] as const,
    }),
  ],
});

const failureExtension = defineExtension({
  name: "failure",
  tools: ({ tool }) => [
    tool({
      name: "read",
      inputSchema: Schema.String,
      outputSchema: Schema.String,
      failureSchema: Schema.Struct({ code: Schema.Literal("NOT_FOUND") }),
      handler: async (slug) => (slug === "missing" ? fail({ code: "NOT_FOUND" }) : ok(slug)),
    }),
  ],
});

defineExtension({
  name: "invalid-failure",
  tools: ({ tool }) => [
    tool({
      name: "read",
      inputSchema: Schema.String,
      // @ts-expect-error Failure is fixed by schemas rather than widened by the handler.
      outputSchema: Schema.String,
      // @ts-expect-error Failure is fixed by schemas rather than widened by the handler.
      failureSchema: Schema.Struct({ code: Schema.Literal("NOT_FOUND") }),
      handler: async () => fail({ code: "OTHER" }),
    }),
  ],
});

const sharedTools = (tool: ToolBuilder<{ readonly db: string }>) => [
  tool({
    name: "shared",
    inputSchema: Schema.String,
    handler: async (_input, { resource }) => resource.db,
  }),
];
defineExtension({
  name: "shared-tools",
  setup: async () => ({ db: "connection" }),
  tools: ({ tool }) => sharedTools(tool),
});
defineExtension({
  name: "shared-tools-without-resource",
  // @ts-expect-error A resource-free builder cannot be passed to a resourceful helper.
  tools: ({ tool }) => sharedTools(tool),
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
type InferredOutputContributions = ContributionsOf<typeof inferredOutputExtension>;
export type OutputIsInferredWithoutSchema = Expect<
  Equal<InferredOutputContributions["list"]["output"], readonly ["a", "b"]>
>;
type FailureContributions = ContributionsOf<typeof failureExtension>;
export type FailureIsInferredFromSchema = Expect<
  Equal<FailureContributions["read"]["failure"], { readonly code: "NOT_FOUND" }>
>;
const sdkToolkitlessExtension = defineExtension({ name: "sdk-toolkitless" });
export type SdkToolkitlessContributionsAreEmpty = Expect<
  Equal<keyof ContributionsOf<typeof sdkToolkitlessExtension>, never>
>;
const sdkResourceToolkitlessExtension = defineExtension<{ readonly db: string }>({
  name: "sdk-resource-toolkitless",
  setup: async () => ({ db: "connection" }),
});
export type SdkResourceToolkitlessContributionsAreEmpty = Expect<
  Equal<keyof ContributionsOf<typeof sdkResourceToolkitlessExtension>, never>
>;
const rootToolsDefinition = defineAgent({
  providers: [model],
  model: "test/default",
  tools: ({ tool }) => [
    tool({ name: "status", inputSchema: Schema.Void, handler: async () => "ready" as const }),
  ],
});
export type AgentToolBuilderPreservesContributions = Expect<
  Equal<keyof ContributionsOf<(typeof rootToolsDefinition.extensions)[0]>, "status">
>;

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
