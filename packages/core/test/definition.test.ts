import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema, Stream } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { createSession, AgentDefinitionError, type AgentDefinition } from "../src/index.js";
import { makeTestModel } from "./model.js";

const model = makeTestModel(() => Stream.empty);
const getAgentDefinitionError = (definition: AgentDefinition) =>
  Effect.flip(createSession(definition));

describe("Agent Definition validation", () => {
  it.effect("rejects duplicate Plugin and Tool names before Session startup", () =>
    Effect.gen(function* () {
      const duplicatePlugins: AgentDefinition = {
        instructions: "Be concise.",
        model,
        plugins: [{ name: "same" }, { name: "same" }],
      };
      const duplicateTools: AgentDefinition = {
        instructions: "Be concise.",
        model,
        plugins: [
          { name: "one", toolkit: Toolkit.make(Tool.make("same", { success: Schema.String })) },
          { name: "two", toolkit: Toolkit.make(Tool.make("same", { success: Schema.String })) },
        ],
      };

      expect(yield* getAgentDefinitionError(duplicatePlugins)).toBeInstanceOf(AgentDefinitionError);
      expect(yield* getAgentDefinitionError(duplicateTools)).toBeInstanceOf(AgentDefinitionError);
    }),
  );

  it.effect("rejects duplicate Tool handler names before Session startup", () =>
    Effect.gen(function* () {
      const tool = Tool.make("echo", { success: Schema.String });
      const definition: AgentDefinition = {
        instructions: "Be concise.",
        model,
        plugins: [
          {
            name: "owner",
            toolkit: Toolkit.make(tool),
            handlers: { echo: () => Effect.succeed("owner") },
          },
          { name: "override", handlers: { echo: () => Effect.succeed("override") } },
        ],
      };

      expect((yield* getAgentDefinitionError(definition)).message).toBe(
        "Duplicate Tool handler name: echo",
      );
    }),
  );

  it.effect("rejects missing and orphaned Tool handlers before Session startup", () =>
    Effect.gen(function* () {
      const missing: AgentDefinition = {
        instructions: "Be concise.",
        model,
        plugins: [
          {
            name: "missing",
            toolkit: Toolkit.make(Tool.make("echo", { success: Schema.String })),
          },
        ],
      };
      const orphaned: AgentDefinition = {
        instructions: "Be concise.",
        model,
        plugins: [{ name: "orphaned", handlers: { echo: () => Effect.succeed("echo") } }],
      };

      expect((yield* getAgentDefinitionError(missing)).message).toBe("Missing Tool handler: echo");
      expect((yield* getAgentDefinitionError(orphaned)).message).toBe(
        "Tool handler has no matching Tool: echo",
      );
    }),
  );

  it.effect("rejects a Tool result validator outside its owning Plugin", () =>
    Effect.gen(function* () {
      const definition: AgentDefinition = {
        instructions: "Be concise.",
        model,
        plugins: [
          {
            name: "validator",
            toolkit: Toolkit.make(Tool.make("owned")),
            handlers: { owned: () => Effect.void },
            toolResultValidators: { other: Effect.succeed },
          },
        ],
      };

      expect((yield* getAgentDefinitionError(definition)).message).toBe(
        "Tool result validator has no matching Tool: other",
      );
    }),
  );
});
