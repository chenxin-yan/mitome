import { describe, expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import { createSession, type Definition, type Session } from "../src/index.js";
import { makeDeterministicModel } from "./model.js";

describe("createSession", () => {
  test("streams one model Step before completion", async () => {
    const fixture = await Effect.runPromise(makeDeterministicModel("hello"));
    const definition: Definition = {
      instructions: "Be concise.",
      model: fixture.model,
      plugins: [],
    };

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
    expect(await Effect.runPromise(fixture.calls)).toBe(1);
  });

  test("isolates and releases session state", async () => {
    const fixture = await Effect.runPromise(makeDeterministicModel("hello"));
    const definition: Definition = {
      instructions: "Be concise.",
      model: fixture.model,
      plugins: [],
    };
    let first: Session | undefined;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          first = yield* createSession(definition);
          const second = yield* createSession(definition);
          yield* Stream.runDrain(first.prompt("first"));
          expect(first.history()).toEqual(["first"]);
          expect(second.history()).toEqual([]);
        }),
      ),
    );

    expect(first?.released()).toBe(true);
    expect(first?.history()).toEqual([]);
  });
});
