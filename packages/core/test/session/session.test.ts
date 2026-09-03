import { describe, expect, it } from "@effect/vitest";
import { Cause, Context, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect";
import { AiError, LanguageModel, Prompt, Response } from "effect/unstable/ai";
import {
  AgentDefinitionError,
  type AgentDefinition,
  createSession,
  defineExtension,
  makeProvider,
  TurnError,
} from "../../src/index.js";
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

  it.effect("rejects provided Service tags absent from the resource Layer context", () =>
    Effect.gen(function* () {
      const ProvidedService = Context.Service<string>("ProvidedService");
      const MissingService = Context.Service<string>("MissingService");
      const resource = Layer.succeed(ProvidedService, "value");
      const extension = defineExtension<
        typeof resource,
        readonly [],
        readonly [typeof MissingService]
      >({
        name: "invalid-provider",
        resource,
        provides: [MissingService],
      });
      const dependentResource = Layer.effect(
        Context.Service<number>("DependentService"),
        Effect.as(MissingService, 1),
      );
      const dependent = defineExtension<typeof dependentResource, readonly [typeof extension]>({
        name: "dependent",
        dependencies: [extension],
        resource: dependentResource,
      });
      const error = yield* Effect.flip(
        createSession({
          providers: [makeTestProvider(() => Stream.empty)],
          model: "test/default",
          extensions: [dependent],
        }),
      );

      expect(error).toBeInstanceOf(AgentDefinitionError);
      expect(error).toMatchObject({
        issues: [
          "Extension invalid-provider Provided Service MissingService is missing from its resource Layer",
        ],
      });
    }),
  );

  it.effect("streams one model Step before completion", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDeterministicProvider("hello");
      const definition: AgentDefinition = {
        providers: [fixture.provider],
        model: "test/default",
        extensions: [],
      };
      const session = yield* createSession(definition);
      const events = yield* Stream.runCollect(session.runTurn("Hi"));

      expect([...events]).toStrictEqual([
        { type: "model-output", text: "hello" },
        { type: "response-complete", finishReason: undefined, usage: undefined },
      ]);
      expect(yield* fixture.calls).toBe(1);
    }),
  );

  it.effect("exposes reasoning and the final finish metadata", () =>
    Effect.gen(function* () {
      const firstUsage = new Response.Usage({
        inputTokens: { total: 2 },
        outputTokens: { total: 1 },
      });
      const finalUsage = new Response.Usage({
        inputTokens: { total: 3 },
        outputTokens: { total: 2, reasoning: 1 },
      });
      const model = makeTestProvider(() =>
        Stream.fromIterable([
          Response.makePart("reasoning-delta", { id: "reasoning", delta: "thinking" }),
          Response.makePart("finish", { reason: "tool-calls", usage: firstUsage }),
          Response.makePart("finish", { reason: "stop", usage: finalUsage }),
        ]),
      );
      const session = yield* createSession({
        providers: [model],
        model: "test/default",
        extensions: [],
      });
      const events = yield* Stream.runCollect(session.runTurn("Hi"));

      expect([...events]).toEqual([
        { type: "reasoning", text: "thinking" },
        { type: "response-complete", finishReason: "stop", usage: finalUsage },
      ]);
    }),
  );

  it.effect("preserves reasoning metadata in history without exposing it as an event", () =>
    Effect.gen(function* () {
      const metadata = {
        openai: { itemId: "reasoning-1", encryptedContent: "encrypted-reasoning" },
      };
      let calls = 0;
      let secondPrompt: Prompt.Prompt | undefined;
      const model = makeTestProvider(({ prompt }) => {
        calls += 1;
        if (calls === 1) {
          return Stream.fromIterable([
            Response.makePart("reasoning-start", { id: "reasoning-1", metadata }),
            Response.makePart("reasoning-delta", { id: "reasoning-1", delta: "summary" }),
            Response.makePart("reasoning-end", { id: "reasoning-1", metadata }),
            Response.makePart("tool-call", {
              id: "call-1",
              name: "lookup",
              params: { query: "mitome" },
              providerExecuted: false,
            }),
          ]);
        }
        secondPrompt = prompt;
        return Stream.succeed(Response.makePart("text-delta", { id: "done", delta: "done" }));
      });
      const session = yield* createSession({
        providers: [model],
        model: "test/default",
        extensions: [],
      });
      const events = yield* Stream.runCollect(session.runTurn("Hi"));

      expect([...events]).toEqual([
        { type: "reasoning", text: "summary" },
        { type: "tool-call", id: "call-1", name: "lookup", params: { query: "mitome" } },
        { type: "model-output", text: "done" },
        { type: "response-complete" },
      ]);
      for (const prompt of [secondPrompt, Prompt.make(session.history())]) {
        const assistant = prompt?.content.find((message) => message.role === "assistant");
        const reasoning = assistant?.content.find((part) => part.type === "reasoning");
        expect(reasoning).toMatchObject({ text: "summary", options: metadata });
      }
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
        extensions: [],
      });
      const events = yield* Stream.runCollect(session.runTurn("Hi")).pipe(
        Effect.provideService(Greeting, { text: "from the caller" }),
      );

      expect([...events]).toEqual([
        { type: "model-output", text: "from the caller" },
        { type: "response-complete" },
      ]);
    }),
  );

  it.effect("composes Extension Instructions into model input and history", () =>
    Effect.gen(function* () {
      let modelPrompt: ReadonlyArray<Prompt.Message> = [];
      const model = makeTestProvider(({ prompt }) => {
        modelPrompt = prompt.content;
        return Stream.succeed(Response.makePart("text-delta", { id: "done", delta: "done" }));
      });
      const session = yield* createSession({
        providers: [model],
        model: "test/default",
        extensions: [
          { name: "first", instructions: "First Extension" },
          { name: "empty", instructions: "" },
          { name: "missing" },
          { name: "last", instructions: "Last Extension" },
        ],
      });
      const expected = [
        {
          role: "system" as const,
          content: "First Extension\n\nLast Extension",
        },
      ];

      expect(session.history().map(({ role, content }) => ({ role, content }))).toEqual(expected);
      yield* Stream.runDrain(session.runTurn("Hi"));
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
        extensions: [{ name: "empty", instructions: "" }, { name: "missing" }],
      });

      expect(session.history().map((message) => message.role)).toEqual([]);
    }),
  );

  it.effect("wraps a failing lazy Provider build as a TurnError on first use", () =>
    Effect.gen(function* () {
      class ProvisionFailure extends Schema.TaggedError<ProvisionFailure>()("ProvisionFailure", {
        message: Schema.String,
      }) {}
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
            extensions: [],
          });
          return yield* Effect.flip(Stream.runDrain(session.runTurn("Hi")));
        }),
      );
      expect(error).toBeInstanceOf(TurnError);
      expect(error).toMatchObject({ _tag: "TurnError", message: "no credential" });
    }),
  );

  it.effect("surfaces provider AiError messages", () =>
    Effect.gen(function* () {
      const cause = AiError.make({
        module: "Test Provider",
        method: "streamText",
        reason: new AiError.UnknownError({ description: "provider unavailable" }),
      });
      const session = yield* createSession({
        providers: [makeTestProvider(() => Stream.fail(cause))],
        model: "test/default",
        extensions: [],
      });

      expect(yield* Effect.flip(Stream.runDrain(session.runTurn("Hi")))).toMatchObject({
        _tag: "TurnError",
        message: cause.reason.message,
        cause,
      });
    }),
  );

  it.effect("fails model error parts without committing Turn history", () =>
    Effect.gen(function* () {
      const cause = new Error("model stream failed");
      const model = makeTestProvider(() =>
        Stream.fromIterable([
          Response.makePart("text-delta", { id: "partial", delta: "partial" }),
          Response.makePart("error", { error: cause }),
        ]),
      );
      const session = yield* createSession({
        providers: [model],
        model: "test/default",
        extensions: [],
      });
      const events: Array<unknown> = [];
      const error = yield* Effect.flip(
        Stream.runDrain(
          session.runTurn("Hi").pipe(Stream.tap((event) => Effect.sync(() => events.push(event)))),
        ),
      );

      expect(error).toMatchObject({ _tag: "TurnError", message: "Turn failed", cause });
      expect(events).toEqual([{ type: "model-output", text: "partial" }]);
      expect(session.history()).toEqual([]);
    }),
  );

  it.effect("isolates and releases session state", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDeterministicProvider("hello");
      const definition: AgentDefinition = {
        providers: [fixture.provider],
        model: "test/default",
        extensions: [],
      };
      const first = yield* Effect.scoped(
        Effect.gen(function* () {
          const first = yield* createSession(definition);
          const second = yield* createSession(definition);
          yield* Stream.runDrain(first.runTurn("first"));
          expect(first.history().map((message) => message.role)).toEqual(["user"]);
          expect(second.history().map((message) => message.role)).toEqual([]);
          return first;
        }),
      );

      expect(first.history()).toEqual([]);
    }),
  );

  it.effect("fails overlapping Turns with a typed busy error", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDeterministicProvider("hello");
      const definition: AgentDefinition = {
        providers: [fixture.provider],
        model: "test/default",
        extensions: [],
      };
      const session = yield* createSession(definition);
      const pull = yield* Stream.toPull(session.runTurn("first"));
      yield* pull;
      const exit = yield* Effect.exit(Stream.runCollect(session.runTurn("second")));

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
        extensions: [],
      });
      const first = yield* Effect.forkChild(Stream.runDrain(session.runTurn("first")));
      yield* Effect.promise(() => started);
      yield* Fiber.interrupt(first);
      expect(session.history().map((message) => message.role)).toEqual([]);
      const events = yield* Stream.runCollect(session.runTurn("second"));

      expect([...events]).toEqual([
        { type: "model-output", text: "done" },
        { type: "response-complete" },
      ]);
      expect(calls).toBe(2);
    }),
  );

  it.effect("allows sequential Turns after a Turn completes", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDeterministicProvider("hello");
      const definition: AgentDefinition = {
        providers: [fixture.provider],
        model: "test/default",
        extensions: [],
      };
      const session = yield* createSession(definition);
      yield* Stream.runDrain(session.runTurn("first"));
      yield* Stream.runDrain(session.runTurn("second"));
      // The deterministic fixture emits bare text-deltas, which record no assistant message.
      expect(session.history().map((message) => message.role)).toEqual(["user", "user"]);
      expect(yield* fixture.calls).toBe(2);
    }),
  );

  it.effect("maps an Approval request without its Tool Call to TurnError", () =>
    Effect.gen(function* () {
      const model = makeProvider("test", [] as const, undefined, () =>
        // SAFETY: this malformed model fake exists only to emit an orphan Approval request.
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
        extensions: [],
      });

      expect(yield* Effect.flip(Stream.runDrain(session.runTurn("Hi")))).toMatchObject({
        _tag: "TurnError",
        message: "Tool approval request is missing its Tool call",
      });
    }),
  );

  it.effect("rejects Turns after the session scope closes", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDeterministicProvider("hello");
      const definition: AgentDefinition = {
        providers: [fixture.provider],
        model: "test/default",
        extensions: [],
      };
      const session = yield* Effect.scoped(createSession(definition));
      const exit = yield* Effect.exit(Stream.runCollect(session.runTurn("late")));

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
