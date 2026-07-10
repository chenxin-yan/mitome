import { describe, expect, test } from "bun:test";
import { Effect, Layer, Ref, Stream } from "effect";
import { LanguageModel, Response } from "effect/unstable/ai";
import { createSession, makeModel } from "@mitome/core";
import { defineAgent, withSession } from "@mitome/sdk";

const makeDeterministicModel = (output: string) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const released = yield* Ref.make(false);
    const layer = Layer.effect(
      LanguageModel.LanguageModel,
      Effect.acquireRelease(
        Effect.succeed({
          streamText: () =>
            Stream.fromEffect(Ref.update(calls, (count) => count + 1)).pipe(
              Stream.map(() =>
                Response.makePart("text-delta", { id: "deterministic", delta: output }),
              ),
            ),
        } as LanguageModel.Service),
        () => Ref.set(released, true),
      ),
    );

    return { model: makeModel(layer), calls: Ref.get(calls), released: Ref.get(released) };
  });

describe("@mitome/sdk", () => {
  test("returns a canonical Definition accepted directly by Core", async () => {
    const fixture = await Effect.runPromise(makeDeterministicModel("hello"));
    const definition = defineAgent({
      instructions: "Be concise.",
      model: fixture.model,
      plugins: [{ name: "first" }, { name: "second" }],
    });

    expect(Object.keys(definition)).toEqual(["instructions", "model", "plugins"]);
    expect(definition.plugins.map((plugin) => plugin.name)).toEqual(["first", "second"]);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* createSession(definition);
          return yield* Stream.runDrain(session.prompt("Hi"));
        }),
      ),
    );
  });

  test("rethrows callback errors after releasing the Session scope", async () => {
    class MyError extends Error {}

    const fixture = await Effect.runPromise(makeDeterministicModel("hello"));
    const definition = defineAgent({
      instructions: "Be concise.",
      model: fixture.model,
      plugins: [],
    });
    let caught: unknown;

    try {
      await withSession(definition, () => {
        throw new MyError("expected");
      });
    } catch (error) {
      caught = error;
    }

    expect(caught instanceof MyError).toBe(true);
    expect(await Effect.runPromise(fixture.released)).toBe(true);
  });

  test("brackets a typed, terminating Turn stream", async () => {
    const fixture = await Effect.runPromise(makeDeterministicModel("hello"));
    const definition = defineAgent({
      instructions: "Be concise.",
      model: fixture.model,
      plugins: [],
    });

    const events = await withSession(definition, async (session) => {
      const collected = [];
      for await (const event of session.prompt("Hi")) {
        collected.push(event);
      }
      return collected;
    });

    expect(events).toEqual([
      { type: "model-output", text: "hello" },
      { type: "response-complete" },
    ]);
    expect(await Effect.runPromise(fixture.calls)).toBe(1);
  });
});
