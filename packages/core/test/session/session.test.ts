import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect";
import { LanguageModel, Response } from "effect/unstable/ai";
import {
  type AgentDefinition,
  createSession,
  makeModel,
  SessionBusyError,
  SessionReleasedError,
  TurnError,
} from "../../src/index.js";
import { makeDeterministicModel, makeTestModel } from "../support/model.js";

describe("createSession", () => {
  it.effect("streams one model Step before completion", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDeterministicModel("hello");
      const definition: AgentDefinition = {
        instructions: "Be concise.",
        model: fixture.model,
        plugins: [],
      };
      const session = yield* createSession(definition);
      const events = yield* Stream.runCollect(session.prompt("Hi"));

      expect([...events]).toEqual([
        { type: "model-output", text: "hello" },
        { type: "response-complete" },
      ]);
      expect(yield* fixture.calls).toBe(1);
    }),
  );

  it.effect("wraps a failing model layer build as a TurnError at startup", () =>
    Effect.gen(function* () {
      class ProvisionFailure extends Schema.TaggedErrorClass<ProvisionFailure>()(
        "ProvisionFailure",
        { message: Schema.String },
      ) {}
      const model = makeModel(
        Layer.effect(
          LanguageModel.LanguageModel,
          Effect.fail(new ProvisionFailure({ message: "no credential" })),
        ),
      );
      const error = yield* Effect.flip(
        Effect.scoped(createSession({ instructions: "", model, plugins: [] })),
      );
      expect(error).toBeInstanceOf(TurnError);
      expect(error).toMatchObject({ _tag: "TurnError", message: "no credential" });
    }),
  );

  it.effect("isolates and releases session state", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDeterministicModel("hello");
      const definition: AgentDefinition = {
        instructions: "Be concise.",
        model: fixture.model,
        plugins: [],
      };
      const first = yield* Effect.scoped(
        Effect.gen(function* () {
          const first = yield* createSession(definition);
          const second = yield* createSession(definition);
          yield* Stream.runDrain(first.prompt("first"));
          expect(first.history().map((message) => message.role)).toEqual(["system", "user"]);
          expect(second.history().map((message) => message.role)).toEqual(["system"]);
          return first;
        }),
      );

      expect(first.released()).toBe(true);
      expect(first.history()).toEqual([]);
    }),
  );

  it.effect("fails overlapping prompts with a typed busy error", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDeterministicModel("hello");
      const definition: AgentDefinition = {
        instructions: "Be concise.",
        model: fixture.model,
        plugins: [],
      };
      const session = yield* createSession(definition);
      const pull = yield* Stream.toPull(session.prompt("first"));
      yield* pull;
      const exit = yield* Effect.exit(Stream.runCollect(session.prompt("second")));

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toBeInstanceOf(SessionBusyError);
      }
      expect(yield* fixture.calls).toBe(1);
    }),
  );

  it.effect("discards cancelled Turn history and reuses the Session", () =>
    Effect.gen(function* () {
      let calls = 0;
      let start!: () => void;
      const started = new Promise<void>((resolve) => (start = resolve));
      const model = makeTestModel(() => {
        calls += 1;
        if (calls === 1) {
          start();
          return Stream.concat(
            Stream.succeed(Response.makePart("text-delta", { id: "first", delta: "partial" })),
            Stream.never,
          );
        }
        return Stream.succeed(Response.makePart("text-delta", { id: "second", delta: "done" }));
      });

      const session = yield* createSession({ instructions: "Be concise.", model, plugins: [] });
      const first = yield* Effect.forkChild(Stream.runDrain(session.prompt("first")));
      yield* Effect.promise(() => started);
      yield* Fiber.interrupt(first);
      expect(session.history().map((message) => message.role)).toEqual(["system"]);
      const events = yield* Stream.runCollect(session.prompt("second"));

      expect([...events]).toEqual([
        { type: "model-output", text: "done" },
        { type: "response-complete" },
      ]);
      expect(calls).toBe(2);
    }),
  );

  it.effect("allows sequential prompts after a Turn completes", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDeterministicModel("hello");
      const definition: AgentDefinition = {
        instructions: "Be concise.",
        model: fixture.model,
        plugins: [],
      };
      const session = yield* createSession(definition);
      yield* Stream.runDrain(session.prompt("first"));
      yield* Stream.runDrain(session.prompt("second"));
      // The deterministic fixture emits bare text-deltas, which record no assistant message.
      expect(session.history().map((message) => message.role)).toEqual(["system", "user", "user"]);
      expect(yield* fixture.calls).toBe(2);
    }),
  );

  it.effect("rejects prompts after the session scope closes", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDeterministicModel("hello");
      const definition: AgentDefinition = {
        instructions: "Be concise.",
        model: fixture.model,
        plugins: [],
      };
      const session = yield* Effect.scoped(createSession(definition));
      const exit = yield* Effect.exit(Stream.runCollect(session.prompt("late")));

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toBeInstanceOf(SessionReleasedError);
      }
      expect(session.history()).toEqual([]);
    }),
  );
});
