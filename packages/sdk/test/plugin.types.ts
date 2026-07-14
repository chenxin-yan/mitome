// oxlint-disable-next-line jsdoc/check-tag-names
/** @effect-diagnostics missingEffectContext:skip-file */
import { Schema } from "effect";
import type { PluginHooks } from "@mitome/core";
import { definePlugin, tool, type PluginHooksDefinition } from "../src/index.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

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

// @ts-expect-error dispose requires setup.
definePlugin({
  name: "dispose-without-setup",
  tools: [],
  dispose: async (resource: string) => void resource,
});
