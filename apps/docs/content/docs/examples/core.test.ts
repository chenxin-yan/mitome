import { expect, test } from "bun:test";
import { Effect, Layer, Stream } from "effect";
import { LanguageModel, Response } from "effect/unstable/ai";
import { createSession, makeModel, type Definition } from "@mitome/core";

const model = makeModel(
  Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () =>
        Stream.succeed(Response.makePart("text-delta", { id: "deterministic", delta: "hello" })),
    }),
  ),
);

// #region definition
const definition: Definition = {
  instructions: "Be concise.",
  model,
  plugins: [],
};
// #endregion definition

test("the Core Session is a scoped Effect Stream", async () => {
  const events = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* createSession(definition);
        return yield* Stream.runCollect(session.prompt("Hi"));
      }),
    ),
  );

  expect([...events]).toEqual([
    { type: "model-output", text: "hello" },
    { type: "response-complete" },
  ]);
});
