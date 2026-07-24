import { describe, expect, test } from "vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import * as core from "@mitome/core";
import { LanguageModel, Response } from "effect/unstable/ai";
import { createSession } from "@mitome/core";
import * as sdkEffect from "../src/effect.js";
import { TurnError, defineAgent, definePlugin, withSession } from "../src/index.js";
import { makeDeterministicProvider, makeTestProvider } from "./provider.js";

class ModelFailure extends Schema.TaggedErrorClass<ModelFailure>()("ModelFailure", {
  message: Schema.String,
}) {}

describe("@mitome/sdk", () => {
  test("re-exports the canonical Effect runtime", () => {
    expect(sdkEffect.createSession).toBe(core.createSession);
  });

  test("returns a canonical Agent Definition accepted directly by Core", async () => {
    const fixture = await Effect.runPromise(makeDeterministicProvider("hello"));
    const definition = defineAgent({
      providers: [fixture.provider],
      model: "test/default",
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
    const fixture = await Effect.runPromise(makeDeterministicProvider("hello"));
    const definition = defineAgent({
      providers: [fixture.provider],
      model: "test/default",
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

  test("forwards a typed per-Turn Model override", async () => {
    const provider = (id: string, output: string) =>
      core.makeProvider(id, [] as const, undefined, () =>
        Layer.succeed(LanguageModel.LanguageModel, {
          streamText: () =>
            Stream.succeed(Response.makePart("text-delta", { id: output, delta: output })),
        } as unknown as LanguageModel.Service),
      );
    const first = provider("first", "default");
    const second = provider("second", "override");
    const definition = defineAgent({
      providers: [first, second] as const,
      model: "first/default",
      plugins: [],
    });

    const output = await withSession(definition, async (session) => {
      const defaults = await Array.fromAsync(session.prompt("one"));
      const override = await Array.fromAsync(session.prompt("two", { model: "second/private" }));
      return [defaults[0], override[0]];
    });

    expect(output).toEqual([
      { type: "model-output", text: "default" },
      { type: "model-output", text: "override" },
    ]);
  });

  test("rethrows callback errors after releasing the Session scope", async () => {
    class MyError extends Error {}

    const fixture = await Effect.runPromise(makeDeterministicProvider("hello"));
    const definition = defineAgent({
      providers: [fixture.provider],
      model: "test/default",
      plugins: [],
    });
    let caught: unknown;

    try {
      await withSession(definition, async (session) => {
        await Array.fromAsync(session.prompt("Hi"));
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
      providers: [makeTestProvider(() => Stream.fail(cause))],
      model: "test/default",
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
    const fixture = await Effect.runPromise(makeDeterministicProvider("hello"));
    const definition = defineAgent({
      providers: [fixture.provider],
      model: "test/default",
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
