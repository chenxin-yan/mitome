import { describe, expect, test } from "bun:test";
import { Effect, Schema, Stream } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { createSession, DefinitionError, type Definition } from "../src/index.js";
import { makeTestModel } from "./model.js";

const model = makeTestModel(() => Stream.empty);
const getDefinitionError = (definition: Definition) =>
  Effect.runPromise(Effect.flip(Effect.scoped(createSession(definition))));

describe("Definition validation", () => {
  test("rejects duplicate Plugin and Tool names before Session startup", async () => {
    const duplicatePlugins: Definition = {
      instructions: "Be concise.",
      model,
      plugins: [{ name: "same" }, { name: "same" }],
    };
    const duplicateTools: Definition = {
      instructions: "Be concise.",
      model,
      plugins: [
        { name: "one", toolkit: Toolkit.make(Tool.make("same", { success: Schema.String })) },
        { name: "two", toolkit: Toolkit.make(Tool.make("same", { success: Schema.String })) },
      ],
    };

    expect(await getDefinitionError(duplicatePlugins)).toBeInstanceOf(DefinitionError);
    expect(await getDefinitionError(duplicateTools)).toBeInstanceOf(DefinitionError);
  });

  test("rejects duplicate Tool handler names before Session startup", async () => {
    const tool = Tool.make("echo", { success: Schema.String });
    const definition: Definition = {
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

    expect((await getDefinitionError(definition)).message).toBe(
      "Duplicate Tool handler name: echo",
    );
  });

  test("rejects missing and orphaned Tool handlers before Session startup", async () => {
    const missing: Definition = {
      instructions: "Be concise.",
      model,
      plugins: [
        {
          name: "missing",
          toolkit: Toolkit.make(Tool.make("echo", { success: Schema.String })),
        },
      ],
    };
    const orphaned: Definition = {
      instructions: "Be concise.",
      model,
      plugins: [{ name: "orphaned", handlers: { echo: () => Effect.succeed("echo") } }],
    };

    expect((await getDefinitionError(missing)).message).toBe("Missing Tool handler: echo");
    expect((await getDefinitionError(orphaned)).message).toBe(
      "Tool handler has no matching Tool: echo",
    );
  });

  test("rejects a Tool result validator outside its owning Plugin", async () => {
    const definition: Definition = {
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

    expect((await getDefinitionError(definition)).message).toBe(
      "Tool result validator has no matching Tool: other",
    );
  });
});
