import { describe, expect, test } from "bun:test";
import { Layer } from "effect";
import { Schema } from "effect";
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai";
import { createSession, DefinitionError, makeModel, type Definition } from "../src/index.js";

const model = makeModel(Layer.succeed(LanguageModel.LanguageModel, {} as LanguageModel.Service));

describe("Definition validation", () => {
  test("rejects duplicate Plugin and Tool names before Session startup", () => {
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

    expect(() => createSession(duplicatePlugins)).toThrow(DefinitionError);
    expect(() => createSession(duplicateTools)).toThrow(DefinitionError);
  });
});
