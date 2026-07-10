import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Stream } from "effect";
import {
  createSession,
  type Definition,
  SessionBusyError,
  SessionReleasedError,
  type Session,
} from "../src/index.js";
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
          expect(first.history().map((message) => message.role)).toEqual(["system", "user"]);
          expect(second.history().map((message) => message.role)).toEqual(["system"]);
        }),
      ),
    );

    expect(first?.released()).toBe(true);
    expect(first?.history()).toEqual([]);
  });

  test("fails overlapping prompts with a typed busy error", async () => {
    const fixture = await Effect.runPromise(makeDeterministicModel("hello"));
    const definition: Definition = {
      instructions: "Be concise.",
      model: fixture.model,
      plugins: [],
    };

    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* createSession(definition);
          const pull = yield* Stream.toPull(session.prompt("first"));
          yield* pull;
          return yield* Effect.exit(Stream.runCollect(session.prompt("second")));
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(SessionBusyError);
    }
  });

  test("allows sequential prompts after a Turn completes", async () => {
    const fixture = await Effect.runPromise(makeDeterministicModel("hello"));
    const definition: Definition = {
      instructions: "Be concise.",
      model: fixture.model,
      plugins: [],
    };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* createSession(definition);
          yield* Stream.runDrain(session.prompt("first"));
          yield* Stream.runDrain(session.prompt("second"));
          // The deterministic fixture emits bare text-deltas, which record no assistant message.
          expect(session.history().map((message) => message.role)).toEqual([
            "system",
            "user",
            "user",
          ]);
        }),
      ),
    );

    expect(await Effect.runPromise(fixture.calls)).toBe(2);
  });

  test("rejects prompts after the session scope closes", async () => {
    const fixture = await Effect.runPromise(makeDeterministicModel("hello"));
    const definition: Definition = {
      instructions: "Be concise.",
      model: fixture.model,
      plugins: [],
    };
    let session: Session | undefined;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          session = yield* createSession(definition);
        }),
      ),
    );

    const exit = await Effect.runPromise(Effect.exit(Stream.runCollect(session!.prompt("late"))));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(SessionReleasedError);
    }
    expect(session?.history()).toEqual([]);
  });
});
