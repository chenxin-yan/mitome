// Bun's async matchers are typed void but must be awaited to stay within the test.
// oxlint-disable typescript/await-thenable
import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema, Stream } from "effect";
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai";
import { createSession, makeModel, type Definition, type TurnEvent } from "../src/index.js";

const approvalModel = () => {
  let calls = 0;
  let prompt: unknown;
  const model = makeModel(
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
  return { model, calls: () => calls, prompt: () => prompt };
};

const start = async (definition: Definition) => {
  let pending!: Extract<TurnEvent, { readonly type: "approval-required" }>;
  let announce!: () => void;
  const announced = new Promise<void>((resolve) => (announce = resolve));
  const events: Array<TurnEvent> = [];
  const turn = Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* createSession(definition);
        yield* Stream.runForEach(session.prompt("Hi"), (event) => {
          events.push(event);
          if (event.type !== "approval-required") return Effect.void;
          pending = event;
          return Effect.sync(announce);
        });
      }),
    ),
  );
  await announced;
  return { events, pending, turn };
};

const definition = (
  needsApproval: Tool.NeedsApproval<any>,
  hooks?: Definition["plugins"][number]["hooks"],
) => {
  const fixture = approvalModel();
  let handlerCalls = 0;
  let postCalls = 0;
  const dangerous = Tool.make("dangerous", {
    parameters: Schema.Struct({ action: Schema.String }),
    success: Schema.String,
    needsApproval,
  });
  return {
    fixture,
    counts: () => ({ handlerCalls, postCalls }),
    definition: {
      instructions: "Be concise.",
      model: fixture.model,
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
            ...hooks,
            postTool: (context) =>
              Effect.sync(() => {
                postCalls += 1;
                return context.result;
              }),
          },
        },
      ],
    } satisfies Definition,
  };
};

describe("Tool Approval", () => {
  test("runs pre-Tool once for an approved Tool and rejects a second decision", async () => {
    let preToolCalls = 0;
    const current = definition(true, {
      preTool: () =>
        Effect.sync(() => {
          preToolCalls += 1;
          return undefined;
        }),
    });
    const turn = await start(current.definition);

    expect(turn.pending).toMatchObject({
      approvalId: expect.any(String),
      toolCallId: "call-approval",
      name: "dangerous",
      params: { action: "delete" },
    });
    expect(current.counts()).toEqual({ handlerCalls: 0, postCalls: 0 });
    expect(current.fixture.calls()).toBe(1);

    await Effect.runPromise(turn.pending.approve());
    await expect(Effect.runPromise(turn.pending.deny("too late"))).rejects.toMatchObject({
      _tag: "ApprovalResolutionError",
    });
    await turn.turn;

    expect(current.counts()).toEqual({ handlerCalls: 1, postCalls: 1 });
    expect(preToolCalls).toBe(1);
    expect(turn.events).toContainEqual({
      type: "tool-result",
      id: "call-approval",
      name: "dangerous",
      result: "executed",
      isFailure: false,
    });
    expect(current.fixture.calls()).toBe(2);
  });

  test("runs pre-Tool once for a plain executed Tool", async () => {
    let preToolCalls = 0;
    const current = definition(false, {
      preTool: () =>
        Effect.sync(() => {
          preToolCalls += 1;
          return undefined;
        }),
    });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* createSession(current.definition);
          yield* Stream.runDrain(session.prompt("Hi"));
        }),
      ),
    );

    expect(current.counts()).toEqual({ handlerCalls: 1, postCalls: 1 });
    expect(preToolCalls).toBe(1);
  });

  test("fails closed when a dynamic predicate fails", async () => {
    // A failing predicate is deliberately outside NeedsApproval's typed surface.
    const current = definition((() =>
      // @effect-diagnostics-next-line globalErrorInEffectFailure:off
      Effect.fail(new Error("predicate failed"))) as unknown as Tool.NeedsApproval<any>);
    const turn = await start(current.definition);

    expect(current.counts()).toEqual({ handlerCalls: 0, postCalls: 0 });
    await Effect.runPromise(turn.pending.deny("declined"));
    await expect(Effect.runPromise(turn.pending.approve())).rejects.toMatchObject({
      _tag: "ApprovalResolutionError",
    });
    await turn.turn;

    expect(current.counts()).toEqual({ handlerCalls: 0, postCalls: 0 });
    expect(turn.events).toContainEqual({
      type: "tool-result",
      id: "call-approval",
      name: "dangerous",
      result: { type: "execution-denied", reason: "declined" },
      isFailure: true,
    });
    expect(JSON.stringify(current.fixture.prompt())).toContain("declined");
  });

  test("fails closed when a dynamic predicate throws", async () => {
    const current = definition(() => {
      throw new Error("predicate threw");
    });
    const turn = await start(current.definition);

    expect(current.counts()).toEqual({ handlerCalls: 0, postCalls: 0 });
    await Effect.runPromise(turn.pending.deny("declined"));
    await turn.turn;
    expect(current.counts()).toEqual({ handlerCalls: 0, postCalls: 0 });
  });

  test("preserves pre-Tool Hook failures", async () => {
    const failure = new Error("pre-tool failed");
    const current = definition(true, { preTool: () => Effect.fail(failure) });

    await expect(
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* createSession(current.definition);
            yield* Stream.runDrain(session.prompt("Hi"));
          }),
        ),
      ),
    ).rejects.toMatchObject({ _tag: "TurnError", cause: failure });
    expect(current.counts()).toEqual({ handlerCalls: 0, postCalls: 0 });
  });

  test("vetoes before approval without prompting", async () => {
    const current = definition(true, { preTool: () => Effect.succeed({ reason: "vetoed" }) });
    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* createSession(current.definition);
          return yield* Stream.runCollect(session.prompt("Hi"));
        }),
      ),
    );

    expect(events.some((event) => event.type === "approval-required")).toBe(false);
    expect(current.counts()).toEqual({ handlerCalls: 0, postCalls: 0 });
    expect(events).toContainEqual({
      type: "tool-result",
      id: "call-approval",
      name: "dangerous",
      result: { type: "execution-denied", reason: "vetoed" },
      isFailure: true,
    });
  });

  test("does not prompt for an empty veto reason", async () => {
    const current = definition(true, { preTool: () => Effect.succeed({ reason: "" }) });
    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* createSession(current.definition);
          return yield* Stream.runCollect(session.prompt("Hi"));
        }),
      ),
    );

    expect(events.some((event) => event.type === "approval-required")).toBe(false);
    expect(current.counts()).toEqual({ handlerCalls: 0, postCalls: 0 });
    expect(events).toContainEqual({
      type: "tool-result",
      id: "call-approval",
      name: "dangerous",
      result: { type: "execution-denied", reason: "" },
      isFailure: true,
    });
  });
});
