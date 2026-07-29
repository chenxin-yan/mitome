import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect";
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai";
import {
  type AgentDefinition,
  createSession,
  makeProvider,
  type TurnEvent,
} from "../../src/index.js";

const approvalModel = () => {
  let calls = 0;
  let prompt: unknown;
  const provider = makeProvider("test", [] as const, undefined, () =>
    Layer.effect(
      LanguageModel.LanguageModel,
      LanguageModel.make({
        generateText: () => Effect.succeed([]),
        streamText: (options) => {
          calls += 1;
          if (calls === 1) {
            return Stream.succeed({
              type: "tool-call" as const,
              id: "call-approval",
              name: "dangerous",
              params: { action: "delete" },
            });
          }
          prompt = options.prompt;
          return Stream.succeed({ type: "text-delta" as const, id: "done", delta: "continued" });
        },
      }),
    ),
  );
  return { provider, calls: () => calls, prompt: () => prompt };
};

const start = (definition: AgentDefinition) =>
  Effect.gen(function* () {
    let pending!: Extract<TurnEvent, { readonly type: "approval-required" }>;
    const announced = yield* Deferred.make<void>();
    const events: Array<TurnEvent> = [];
    const turn = yield* Effect.forkChild(
      Effect.gen(function* () {
        const session = yield* createSession(definition);
        yield* Stream.runForEach(session.prompt("Hi"), (event) => {
          events.push(event);
          if (event.type !== "approval-required") return Effect.void;
          pending = event;
          return Deferred.succeed(announced, undefined);
        });
      }),
    );
    yield* Deferred.await(announced);
    return { events, pending, turn };
  });

type PreTool = NonNullable<NonNullable<AgentDefinition["plugins"][number]["hooks"]>["preTool"]>;

const definition = (preTool?: PreTool) => {
  const fixture = approvalModel();
  let handlerCalls = 0;
  let postCalls = 0;
  let preToolCalls = 0;
  const dangerous = Tool.make("dangerous", {
    parameters: Schema.Struct({ action: Schema.String }),
    success: Schema.String,
    needsApproval: true,
  });
  return {
    fixture,
    counts: () => ({ handlerCalls, postCalls, preToolCalls }),
    definition: {
      providers: [fixture.provider],
      model: "test/default",
      plugins: [
        {
          name: "dangerous",
          toolkit: Toolkit.make(dangerous),
          handlers: {
            dangerous: () =>
              Effect.sync(() => {
                handlerCalls += 1;
                return "executed";
              }),
          },
          hooks: {
            preTool: (context) =>
              Effect.sync(() => {
                preToolCalls += 1;
              }).pipe(Effect.andThen(preTool?.(context) ?? Effect.void)),
            postTool: (context) =>
              Effect.sync(() => {
                postCalls += 1;
                return context.result;
              }),
          },
        },
      ],
    } satisfies AgentDefinition,
  };
};

describe("Session Approval event adaptation", () => {
  it.effect("adapts an approved pending Tool Call", () =>
    Effect.gen(function* () {
      const current = definition();
      const turn = yield* start(current.definition);

      expect(turn.pending).toMatchObject({
        approvalId: expect.any(String),
        toolCallId: "call-approval",
        name: "dangerous",
        params: { action: "delete" },
      });
      expect(current.counts()).toEqual({ handlerCalls: 0, postCalls: 0, preToolCalls: 1 });
      expect(current.fixture.calls()).toBe(1);

      yield* turn.pending.approve();
      yield* Fiber.join(turn.turn);

      expect(current.counts()).toEqual({ handlerCalls: 1, postCalls: 1, preToolCalls: 1 });
      expect(turn.events).toContainEqual({
        type: "tool-result",
        id: "call-approval",
        name: "dangerous",
        result: "executed",
        isFailure: false,
      });
      expect(current.fixture.calls()).toBe(2);
    }),
  );

  it.effect("adapts a denied pending Tool Call and continues the Turn", () =>
    Effect.gen(function* () {
      const current = definition();
      const turn = yield* start(current.definition);

      yield* turn.pending.deny("not allowed");
      yield* Fiber.join(turn.turn);

      expect(current.counts()).toEqual({ handlerCalls: 0, postCalls: 0, preToolCalls: 1 });
      expect(turn.events).toContainEqual({
        type: "tool-result",
        id: "call-approval",
        name: "dangerous",
        result: { type: "execution-denied", reason: "not allowed" },
        isFailure: true,
      });
      expect(current.fixture.calls()).toBe(2);
      expect(JSON.stringify(current.fixture.prompt())).toContain("not allowed");
    }),
  );

  it.effect("adapts pre-Tool Hook failures to TurnError", () =>
    Effect.gen(function* () {
      const failure = new Error("pre-tool failed");
      const current = definition(() => Effect.fail(failure));

      expect(
        yield* Effect.flip(
          Effect.gen(function* () {
            const session = yield* createSession(current.definition);
            yield* Stream.runDrain(session.prompt("Hi"));
          }),
        ),
      ).toMatchObject({ _tag: "TurnError", cause: failure });
      expect(current.counts()).toEqual({ handlerCalls: 0, postCalls: 0, preToolCalls: 1 });
    }),
  );

  it.effect("adapts a pre-Tool veto without requesting Approval", () =>
    Effect.gen(function* () {
      const current = definition(() => Effect.succeed({ reason: "vetoed" }));
      const session = yield* createSession(current.definition);
      const events = yield* Stream.runCollect(session.prompt("Hi"));

      expect(events.some((event) => event.type === "approval-required")).toBe(false);
      expect(current.counts()).toEqual({ handlerCalls: 0, postCalls: 0, preToolCalls: 1 });
      expect(events).toContainEqual({
        type: "tool-result",
        id: "call-approval",
        name: "dangerous",
        result: { type: "execution-denied", reason: "vetoed" },
        isFailure: true,
      });
    }),
  );
});
