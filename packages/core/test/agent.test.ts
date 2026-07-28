import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema, Stream } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import {
  createSession,
  defineAgent,
  AgentDefinitionError,
  makeProvider,
  type AgentDefinition,
} from "../src/index.js";
import { makeTestProvider } from "./support/provider.js";

const model = makeTestProvider(() => Stream.empty);
const getAgentDefinitionError = (definition: AgentDefinition) =>
  Effect.flip(createSession(definition));

type AgentDefinitionKeysAreExact = keyof AgentDefinition extends "providers" | "model" | "plugins"
  ? "providers" | "model" | "plugins" extends keyof AgentDefinition
    ? true
    : false
  : false;
const exactAgentDefinitionKeys: AgentDefinitionKeysAreExact = true;
void exactAgentDefinitionKeys;

// @ts-expect-error Agent Definition Instructions are contributed by Plugins.
defineAgent({ instructions: "old", providers: [model], model: "test/default", plugins: [] });

describe("Agent Definition validation", () => {
  it.effect("rejects the retired Instructions field from structural callers", () =>
    Effect.gen(function* () {
      const structural = {
        instructions: "old",
        providers: [model],
        model: "test/default" as const,
        plugins: [],
      };
      const definition: AgentDefinition = structural;

      expect(yield* getAgentDefinitionError(definition)).toMatchObject({
        message: "Agent Definition Instructions must be contributed by Plugins",
      });
    }),
  );

  it.effect("rejects duplicate Providers and invalid Default Model selections", () =>
    Effect.gen(function* () {
      const provider = makeProvider("registered", [] as const, undefined, () => {
        throw new Error("validation must not provision Models");
      });
      const invalidDefinition = (model: string, providers = [provider]) =>
        ({ providers, model, plugins: [] }) as AgentDefinition;

      expect(
        (yield* getAgentDefinitionError(
          invalidDefinition("registered/model", [provider, provider]),
        )).message,
      ).toBe("Duplicate Provider id: registered");
      expect((yield* getAgentDefinitionError(invalidDefinition("registered/"))).message).toBe(
        "Malformed Qualified Model id: registered/",
      );
      expect((yield* getAgentDefinitionError(invalidDefinition("missing/model"))).message).toBe(
        "Unregistered Provider id: missing",
      );
    }),
  );

  it.effect("rejects duplicate Plugin and Tool names before Session startup", () =>
    Effect.gen(function* () {
      const duplicatePlugins: AgentDefinition = {
        providers: [model],
        model: "test/default",
        plugins: [{ name: "same" }, { name: "same" }],
      };
      const duplicateTools: AgentDefinition = {
        providers: [model],
        model: "test/default",
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
        providers: [model],
        model: "test/default",
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
        providers: [model],
        model: "test/default",
        plugins: [
          {
            name: "missing",
            toolkit: Toolkit.make(Tool.make("echo", { success: Schema.String })),
          },
        ],
      };
      const orphaned: AgentDefinition = {
        providers: [model],
        model: "test/default",
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
        providers: [model],
        model: "test/default",
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
