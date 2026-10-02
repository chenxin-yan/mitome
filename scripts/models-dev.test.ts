import { expect, test } from "bun:test";
import { toolCapableOpenAiModels } from "./models-dev.ts";

test("reads limit.context per tool-capable model and never guesses a missing one", () => {
  expect(
    toolCapableOpenAiModels({
      openai: {
        models: {
          windowed: { id: "windowed", tool_call: true, limit: { context: 128_000, output: 1 } },
          unlimited: { id: "unlimited", tool_call: true },
          malformed: { id: "malformed", tool_call: true, limit: { context: "128k" } },
          noTools: { id: "no-tools", tool_call: false, limit: { context: 8_192 } },
        },
      },
    }),
  ).toEqual([
    { id: "windowed", contextWindow: 128_000 },
    { id: "unlimited", contextWindow: undefined },
    { id: "malformed", contextWindow: undefined },
  ]);
});

test("filters malformed models without rejecting the models.dev response", () => {
  expect(
    toolCapableOpenAiModels({
      openai: {
        models: {
          valid: { id: "valid", tool_call: true },
          missingId: { tool_call: true },
          wrongCapability: { id: "wrong", tool_call: "yes" },
        },
      },
    }).map((model) => model.id),
  ).toEqual(["valid"]);
});
