import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect";
import { LanguageModel, Response, Tool, Toolkit } from "effect/unstable/ai";
import { type AgentDefinition, createSession, makeModel, type TurnEvent } from "../../src/index.js";

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
          return Stream.succeed({
            type: "text-delta" as const,
            id: "done",
            delta: "continued",
          });
        },
      }),
    ),
  );
  return { model, calls: () => calls, prompt: () => prompt };
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

const definition = (
  needsApproval: Tool.NeedsApproval<any>,
  hooks?: AgentDefinition["plugins"][number]["hooks"],
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
    } satisfies AgentDefinition,
  };
};

describe("Tool Approval", () => {
  it.effect("runs pre-Tool once for an approved Tool and rejects a second decision", () =>
    Effect.gen(function* () {
      let preToolCalls = 0;
      const current = definition(true, {
        preTool: () =>
          Effect.sync(() => {
            preToolCalls += 1;
            return undefined;
          }),
      });
      const turn = yield* start(current.definition);

      expect(turn.pending).toMatchObject({
        approvalId: expect.any(String),
        toolCallId: "call-approval",
        name: "dangerous",
        params: { action: "delete" },
      });
      expect(current.counts()).toEqual({ handlerCalls: 0, postCalls: 0 });
      expect(current.fixture.calls()).toBe(1);

      yield* turn.pending.approve();
      expect(yield* Effect.flip(turn.pending.deny("too late"))).toMatchObject({
        _tag: "ApprovalResolutionError",
      });
      yield* Fiber.join(turn.turn);

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
    }),
  );

  it.effect("runs pre-Tool once for a plain executed Tool", () =>
    Effect.gen(function* () {
      let preToolCalls = 0;
      const current = definition(false, {
        preTool: () =>
          Effect.sync(() => {
            preToolCalls += 1;
            return undefined;
          }),
      });
      const session = yield* createSession(current.definition);
      yield* Stream.runDrain(session.prompt("Hi"));

      expect(current.counts()).toEqual({ handlerCalls: 1, postCalls: 1 });
      expect(preToolCalls).toBe(1);
    }),
  );

  it.effect("prompts when a dynamic predicate returns true", () =>
    Effect.gen(function* () {
      const current = definition(
        (params: { readonly action: string }) => params.action === "delete",
      );
      const turn = yield* start(current.definition);

      expect(turn.pending.name).toBe("dangerous");
      expect(current.counts()).toEqual({ handlerCalls: 0, postCalls: 0 });
      yield* turn.pending.approve();
      yield* Fiber.join(turn.turn);

      expect(current.counts()).toEqual({ handlerCalls: 1, postCalls: 1 });
    }),
  );

  it.effect("executes without prompting when a dynamic predicate returns false", () =>
    Effect.gen(function* () {
      const current = definition(
        (params: { readonly action: string }) => params.action !== "delete",
      );
      const session = yield* createSession(current.definition);
      const events = yield* Stream.runCollect(session.prompt("Hi"));

      expect(events.some((event) => event.type === "approval-required")).toBe(false);
      expect(current.counts()).toEqual({ handlerCalls: 1, postCalls: 1 });
    }),
  );

  it.effect("denies a pending approval and continues the Turn", () =>
    Effect.gen(function* () {
      const current = definition(true);
      const turn = yield* start(current.definition);

      yield* turn.pending.deny("not allowed");
      yield* Fiber.join(turn.turn);

      expect(current.counts()).toEqual({ handlerCalls: 0, postCalls: 0 });
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

  it.effect("runs pre-Tool once when the model reorders params keys", () =>
    Effect.gen(function* () {
      // needsApproval sees decoded (declaration-ordered) params while immediate
      // execution passes the raw model params: reordered keys must not desync
      // the prepared pre-Tool state and re-run the Hook.
      let preToolCalls = 0;
      let handlerCalls = 0;
      let calls = 0;
      const model = makeModel(
        Layer.effect(
          LanguageModel.LanguageModel,
          LanguageModel.make({
            generateText: () => Effect.succeed([]),
            streamText: () => {
              calls += 1;
              if (calls === 1) {
                return Stream.succeed({
                  type: "tool-call" as const,
                  id: "call-approval",
                  name: "dangerous",
                  // Key order differs from the schema declaration below.
                  params: { target: "db", action: "delete" },
                });
              }
              return Stream.succeed({
                type: "text-delta" as const,
                id: "done",
                delta: "continued",
              });
            },
          }),
        ),
      );
      const dangerous = Tool.make("dangerous", {
        parameters: Schema.Struct({
          action: Schema.String,
          target: Schema.String,
        }),
        success: Schema.String,
        needsApproval: false,
      });
      const session = yield* createSession({
        instructions: "Be concise.",
        model,
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
              preTool: () =>
                Effect.sync(() => {
                  preToolCalls += 1;
                  return undefined;
                }),
            },
          },
        ],
      });
      yield* Stream.runDrain(session.prompt("Hi"));

      expect(preToolCalls).toBe(1);
      expect(handlerCalls).toBe(1);
    }),
  );

  it.effect("runs pre-Tool once when decoded params add defaults", () =>
    Effect.gen(function* () {
      const fixture = approvalModel();
      let preToolCalls = 0;
      const dangerous = Tool.make("dangerous", {
        parameters: Schema.Struct({
          action: Schema.String,
          destructive: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
        }),
        success: Schema.String,
        needsApproval: false,
      });
      const session = yield* createSession({
        instructions: "Be concise.",
        model: fixture.model,
        plugins: [
          {
            name: "dangerous",
            toolkit: Toolkit.make(dangerous),
            handlers: { dangerous: () => Effect.succeed("executed") },
            hooks: {
              preTool: () =>
                Effect.sync(() => {
                  preToolCalls += 1;
                }),
            },
          },
        ],
      });
      yield* Stream.runDrain(session.prompt("Hi"));

      expect(preToolCalls).toBe(1);
    }),
  );

  it.effect("maps an approval request without its Tool call to TurnError", () =>
    Effect.gen(function* () {
      const model = makeModel(
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
        instructions: "Be concise.",
        model,
        plugins: [],
      });

      expect(yield* Effect.flip(Stream.runDrain(session.prompt("Hi")))).toMatchObject({
        _tag: "TurnError",
        message: "Tool approval request is missing its Tool call",
      });
    }),
  );

  it.effect("fails closed when a dynamic predicate fails", () =>
    Effect.gen(function* () {
      // A failing predicate is deliberately outside NeedsApproval's typed surface.
      const current = definition((() =>
        Effect.fail(
          // @effect-diagnostics-next-line globalErrorInEffectFailure:off
          new Error("predicate failed"),
        )) as unknown as Tool.NeedsApproval<any>);
      const turn = yield* start(current.definition);

      expect(current.counts()).toEqual({ handlerCalls: 0, postCalls: 0 });
      yield* turn.pending.deny("declined");
      expect(yield* Effect.flip(turn.pending.approve())).toMatchObject({
        _tag: "ApprovalResolutionError",
      });
      yield* Fiber.join(turn.turn);

      expect(current.counts()).toEqual({ handlerCalls: 0, postCalls: 0 });
      expect(turn.events).toContainEqual({
        type: "tool-result",
        id: "call-approval",
        name: "dangerous",
        result: { type: "execution-denied", reason: "declined" },
        isFailure: true,
      });
      expect(JSON.stringify(current.fixture.prompt())).toContain("declined");
    }),
  );

  it.effect("fails closed when a dynamic predicate throws", () =>
    Effect.gen(function* () {
      const current = definition(() => {
        throw new Error("predicate threw");
      });
      const turn = yield* start(current.definition);

      expect(current.counts()).toEqual({ handlerCalls: 0, postCalls: 0 });
      yield* turn.pending.deny("declined");
      yield* Fiber.join(turn.turn);
      expect(current.counts()).toEqual({ handlerCalls: 0, postCalls: 0 });
    }),
  );

  it.effect("preserves pre-Tool Hook failures", () =>
    Effect.gen(function* () {
      const failure = new Error("pre-tool failed");
      const current = definition(true, { preTool: () => Effect.fail(failure) });

      expect(
        yield* Effect.flip(
          Effect.gen(function* () {
            const session = yield* createSession(current.definition);
            yield* Stream.runDrain(session.prompt("Hi"));
          }),
        ),
      ).toMatchObject({
        _tag: "TurnError",
        cause: failure,
      });
      expect(current.counts()).toEqual({ handlerCalls: 0, postCalls: 0 });
    }),
  );

  it.effect("vetoes before approval without prompting", () =>
    Effect.gen(function* () {
      const current = definition(true, {
        preTool: () => Effect.succeed({ reason: "vetoed" }),
      });
      const session = yield* createSession(current.definition);
      const events = yield* Stream.runCollect(session.prompt("Hi"));

      expect(events.some((event) => event.type === "approval-required")).toBe(false);
      expect(current.counts()).toEqual({ handlerCalls: 0, postCalls: 0 });
      expect(events).toContainEqual({
        type: "tool-result",
        id: "call-approval",
        name: "dangerous",
        result: { type: "execution-denied", reason: "vetoed" },
        isFailure: true,
      });
    }),
  );

  it.effect("does not prompt for an empty veto reason", () =>
    Effect.gen(function* () {
      const current = definition(true, {
        preTool: () => Effect.succeed({ reason: "" }),
      });
      const session = yield* createSession(current.definition);
      const events = yield* Stream.runCollect(session.prompt("Hi"));

      expect(events.some((event) => event.type === "approval-required")).toBe(false);
      expect(current.counts()).toEqual({ handlerCalls: 0, postCalls: 0 });
      expect(events).toContainEqual({
        type: "tool-result",
        id: "call-approval",
        name: "dangerous",
        result: { type: "execution-denied", reason: "" },
        isFailure: true,
      });
    }),
  );
});
