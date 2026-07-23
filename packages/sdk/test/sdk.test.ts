import { describe, expect, test } from "vitest";
import { Effect, Schema, Stream } from "effect";
import * as core from "@mitome/core";
import { createSession } from "@mitome/core";
import * as sdkEffect from "../src/effect.js";
import { TurnError, defineAgent, definePlugin, withSession } from "../src/index.js";
import { makeDeterministicModel, makeTestModel } from "./model.js";

class ModelFailure extends Schema.TaggedErrorClass<ModelFailure>()("ModelFailure", {
  message: Schema.String,
}) {}

describe("@mitome/sdk", () => {
  test("re-exports the canonical Effect runtime", () => {
    expect(sdkEffect.createSession).toBe(core.createSession);
  });

  test("returns a canonical Agent Definition accepted directly by Core", async () => {
    const fixture = await Effect.runPromise(makeDeterministicModel("hello"));
    const definition = defineAgent({
      model: fixture.model,
      plugins: [{ name: "first" }, { name: "second" }],
    });

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

  test("adapts SDK Plugin Instructions into Core Session history", async () => {
    const fixture = await Effect.runPromise(makeDeterministicModel("hello"));
    const definition = defineAgent({
      model: fixture.model,
      plugins: [
        definePlugin({ name: "instructions", instructions: "SDK Instructions", tools: [] }),
      ],
    });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* createSession(definition);
          expect(session.history().map(({ role, content }) => ({ role, content }))).toEqual([
            { role: "system", content: "SDK Instructions" },
          ]);
        }),
      ),
    );
  });

  test("rethrows callback errors after releasing the Session scope", async () => {
    class MyError extends Error {}

    const fixture = await Effect.runPromise(makeDeterministicModel("hello"));
    const definition = defineAgent({
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

  test("throws tagged Turn errors with their original cause", async () => {
    const cause = new ModelFailure({ message: "model failed" });
    const definition = defineAgent({
      model: makeTestModel(() => Stream.fail(cause)),
      plugins: [],
    });
    let caught: unknown;

    try {
      await withSession(definition, async (session) => {
        for await (const _event of session.prompt("Hi")) {
          // The stream fails before producing an event.
        }
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TurnError);
    expect(caught).toMatchObject({ _tag: "TurnError", name: "TurnError", cause });
  });

  test("brackets a typed, terminating Turn stream", async () => {
    const fixture = await Effect.runPromise(makeDeterministicModel("hello"));
    const definition = defineAgent({
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
