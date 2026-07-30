import { describe, expect, test } from "vitest";
import { Effect, Schema, Stream } from "effect";
import * as core from "@mitome/core";
import { Response } from "effect/unstable/ai";
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

  test("exposes synchronous Core Session history", async () => {
    const definition = defineAgent({
      providers: [
        makeTestProvider(() =>
          Stream.fromIterable([
            Response.makePart("text-start", { id: "response" }),
            Response.makePart("text-delta", { id: "response", delta: "hello" }),
            Response.makePart("text-end", { id: "response" }),
          ]),
        ),
      ],
      model: "test/default",
      plugins: [],
    });

    const roles = await withSession(definition, async (session) => {
      expect(session.history()).toEqual([]);
      await Array.fromAsync(session.prompt("Hi"));
      return session.history().map((message) => message.role);
    });

    expect(roles).toEqual(["user", "assistant"]);
  });

  test("forwards a typed per-Turn Model override", async () => {
    const provider = (id: string, output: string) =>
      makeTestProvider(
        () => Stream.succeed(Response.makePart("text-delta", { id: output, delta: output })),
        id,
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

  test("passes reasoning and finish metadata through the Promise Session", async () => {
    const usage = new Response.Usage({
      inputTokens: { total: 3 },
      outputTokens: { total: 2, reasoning: 1 },
    });
    const definition = defineAgent({
      providers: [
        makeTestProvider(() =>
          Stream.fromIterable([
            Response.makePart("reasoning-delta", { id: "reasoning", delta: "thinking" }),
            Response.makePart("finish", { reason: "stop", usage }),
          ]),
        ),
      ],
      model: "test/default",
      plugins: [],
    });

    const events = await withSession(definition, (session) =>
      Array.fromAsync(session.prompt("Hi")),
    );

    expect(events).toEqual([
      { type: "reasoning", text: "thinking" },
      { type: "response-complete", finishReason: "stop", usage },
    ]);
  });

  test("starts post-scope iteration with SessionReleasedError", async () => {
    const fixture = await Effect.runPromise(makeDeterministicProvider("hello"));
    const definition = defineAgent({
      providers: [fixture.provider],
      model: "test/default",
      plugins: [],
    });
    let iterable!: AsyncIterable<unknown>;

    await withSession(definition, async (session) => {
      iterable = session.prompt("late");
    });

    let iterator!: AsyncIterator<unknown>;
    expect(() => {
      iterator = iterable[Symbol.asyncIterator]();
    }).not.toThrow();
    await expect(iterator.next()).rejects.toMatchObject({
      _tag: "SessionReleasedError",
      message: "Session scope has been released",
    });
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
