import { describe, expect, it } from "@effect/vitest";
import { Cause, Context, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect";
import { LanguageModel, Prompt, Response } from "effect/unstable/ai";
import { type AgentDefinition, createSession, makeProvider, TurnError } from "../../src/index.js";
import { makeDeterministicProvider, makeTestProvider } from "../support/provider.js";

describe("createSession", () => {
  it("encodes TurnError defects for persistence", () => {
    expect(
      Schema.encodeUnknownSync(TurnError)(
        new TurnError({ message: "Turn failed", cause: new Error("provider failed") }),
      ),
    ).toEqual({
      _tag: "TurnError",
      message: "Turn failed",
      cause: { name: "Error", message: "provider failed" },
    });
  });

  it.effect("streams one model Step before completion", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDeterministicProvider("hello");
      const definition: AgentDefinition = {
        providers: [fixture.provider],
        model: "test/default",
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

  it.effect("keeps caller-provided services visible during stream execution", () =>
    Effect.gen(function* () {
      class Greeting extends Context.Service<Greeting, { readonly text: string }>()("Greeting") {}
      const model = makeTestProvider(() =>
        Stream.fromEffect(
          Effect.map(Effect.service(Greeting), ({ text }) =>
            Response.makePart("text-delta", { id: "caller", delta: text }),
          ),
        ),
      );
      const session = yield* createSession({
        providers: [model],
        model: "test/default",
        plugins: [],
      });
      const events = yield* Stream.runCollect(session.prompt("Hi")).pipe(
        Effect.provideService(Greeting, { text: "from the caller" }),
      );

      expect([...events]).toEqual([
        { type: "model-output", text: "from the caller" },
        { type: "response-complete" },
      ]);
    }),
  );

  it.effect("composes Plugin Instructions into model input and history", () =>
    Effect.gen(function* () {
      let modelPrompt: ReadonlyArray<Prompt.Message> = [];
      const model = makeTestProvider(({ prompt }) => {
        modelPrompt = prompt.content;
        return Stream.succeed(Response.makePart("text-delta", { id: "done", delta: "done" }));
      });
      const session = yield* createSession({
        providers: [model],
        model: "test/default",
        plugins: [
          { name: "first", instructions: "First Plugin" },
          { name: "empty", instructions: "" },
          { name: "missing" },
          { name: "last", instructions: "Last Plugin" },
        ],
      });
      const expected = [
        {
          role: "system" as const,
          content: "First Plugin\n\nLast Plugin",
        },
      ];

      expect(session.history().map(({ role, content }) => ({ role, content }))).toEqual(expected);
      yield* Stream.runDrain(session.prompt("Hi"));
      expect(modelPrompt[0]).toMatchObject(expected[0]!);
      expect(modelPrompt.map((message) => message.role)).toEqual(["system", "user"]);
      expect(session.history()[0]).toMatchObject(expected[0]!);
      expect(session.history().map((message) => message.role)).toEqual(["system", "user"]);
    }),
  );

  it.effect("starts without a system message when no Instructions contribute", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDeterministicProvider("hello");
      const session = yield* createSession({
        providers: [fixture.provider],
        model: "test/default",
        plugins: [{ name: "empty", instructions: "" }, { name: "missing" }],
      });

      expect(session.history().map((message) => message.role)).toEqual([]);
    }),
  );

  it.effect("wraps a failing lazy Provider build as a TurnError on first use", () =>
    Effect.gen(function* () {
      class ProvisionFailure extends Schema.TaggedErrorClass<ProvisionFailure>()(
        "ProvisionFailure",
        { message: Schema.String },
      ) {}
      const model = makeProvider("test", [] as const, undefined, () =>
        Layer.effect(
          LanguageModel.LanguageModel,
          Effect.fail(new ProvisionFailure({ message: "no credential" })),
        ),
      );
      const error = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* createSession({
            providers: [model],
            model: "test/default",
            plugins: [],
          });
          return yield* Effect.flip(Stream.runDrain(session.prompt("Hi")));
        }),
      );
      expect(error).toBeInstanceOf(TurnError);
      expect(error).toMatchObject({ _tag: "TurnError", message: "no credential" });
    }),
  );

  it.effect("isolates and releases session state", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDeterministicProvider("hello");
      const definition: AgentDefinition = {
        providers: [fixture.provider],
        model: "test/default",
        plugins: [],
      };
      const first = yield* Effect.scoped(
        Effect.gen(function* () {
          const first = yield* createSession(definition);
          const second = yield* createSession(definition);
          yield* Stream.runDrain(first.prompt("first"));
          expect(first.history().map((message) => message.role)).toEqual(["user"]);
          expect(second.history().map((message) => message.role)).toEqual([]);
          return first;
        }),
      );

      expect(first.history()).toEqual([]);
    }),
  );

  it.effect("fails overlapping prompts with a typed busy error", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDeterministicProvider("hello");
      const definition: AgentDefinition = {
        providers: [fixture.provider],
        model: "test/default",
        plugins: [],
      };
      const session = yield* createSession(definition);
      const pull = yield* Stream.toPull(session.prompt("first"));
      yield* pull;
      const exit = yield* Effect.exit(Stream.runCollect(session.prompt("second")));

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          _tag: "SessionBusyError",
          message: "Session is busy with an active Turn",
        });
      }
      expect(yield* fixture.calls).toBe(1);
    }),
  );

  it.effect("discards cancelled Turn history and reuses the Session", () =>
    Effect.gen(function* () {
      let calls = 0;
      let start!: () => void;
      const started = new Promise<void>((resolve) => (start = resolve));
      const model = makeTestProvider(() => {
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

      const session = yield* createSession({
        providers: [model],
        model: "test/default",
        plugins: [],
      });
      const first = yield* Effect.forkChild(Stream.runDrain(session.prompt("first")));
      yield* Effect.promise(() => started);
      yield* Fiber.interrupt(first);
      expect(session.history().map((message) => message.role)).toEqual([]);
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
      const fixture = yield* makeDeterministicProvider("hello");
      const definition: AgentDefinition = {
        providers: [fixture.provider],
        model: "test/default",
        plugins: [],
      };
      const session = yield* createSession(definition);
      yield* Stream.runDrain(session.prompt("first"));
      yield* Stream.runDrain(session.prompt("second"));
      // The deterministic fixture emits bare text-deltas, which record no assistant message.
      expect(session.history().map((message) => message.role)).toEqual(["user", "user"]);
      expect(yield* fixture.calls).toBe(2);
    }),
  );

  it.effect("maps an Approval request without its Tool Call to TurnError", () =>
    Effect.gen(function* () {
      const model = makeProvider("test", [] as const, undefined, () =>
        Layer.succeed(LanguageModel.LanguageModel, {
          streamText: () =>
            Stream.succeed(
              Response.makePart("tool-approval-request", {
                approvalId: "approval-missing",
                toolCallId: "call-missing",
              }),
            ),
        } as never),
      );
      const session = yield* createSession({
        providers: [model],
        model: "test/default",
        plugins: [],
      });

      expect(yield* Effect.flip(Stream.runDrain(session.prompt("Hi")))).toMatchObject({
        _tag: "TurnError",
        message: "Tool approval request is missing its Tool call",
      });
    }),
  );

  it.effect("rejects prompts after the session scope closes", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDeterministicProvider("hello");
      const definition: AgentDefinition = {
        providers: [fixture.provider],
        model: "test/default",
        plugins: [],
      };
      const session = yield* Effect.scoped(createSession(definition));
      const exit = yield* Effect.exit(Stream.runCollect(session.prompt("late")));

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          _tag: "SessionReleasedError",
          message: "Session scope has been released",
        });
      }
      expect(session.history()).toEqual([]);
    }),
  );
});
