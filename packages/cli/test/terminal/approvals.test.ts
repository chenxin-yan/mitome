import { describe, expect, it } from "@effect/vitest";
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Scheduler,
  Schema,
  Stream,
} from "effect";
import { LanguageModel, Prompt, type Response, Tool, Toolkit } from "effect/ai";
import {
  Agent,
  Approver,
  Mitome,
  Provider,
  reportModelRequest,
  Turn,
  withModelRequestAccounting,
} from "@mitome/core";
import { type LocalTools, localTools, loop, step } from "@mitome/core/kernel";
import { makeApprovals, type PendingApproval } from "../../src/terminal/approvals.ts";

// Parameters that decode to something other than their wire form, so the JSON shown and the value
// dispatched can be told apart.
const Charge = Tool.make("charge", {
  parameters: Schema.Struct({ cents: Schema.FiniteFromString, memo: Schema.String }),
  success: Schema.String,
  failureMode: "return",
  needsApproval: true,
});
const Kit = Toolkit.make(Charge);

class Tools extends Context.Service<Tools, LocalTools<Toolkit.Tools<typeof Kit>>>()("test/Tools") {}

type Script = Array<ReadonlyArray<Response.PartEncoded>>;

const text = (value: string): Response.TextPartEncoded => ({ type: "text", text: value });
const finish = (reason: Response.FinishReason): Response.FinishPartEncoded => ({
  type: "finish",
  reason,
  usage: { inputTokens: {}, outputTokens: {} },
});

const scriptedModel = (script: Script) =>
  withModelRequestAccounting(
    "scripted",
    Layer.effect(
      LanguageModel.LanguageModel,
      LanguageModel.make({
        generateText: () =>
          Effect.gen(function* () {
            yield* reportModelRequest;
            const next = script.shift();
            if (next === undefined) {
              return yield* Effect.die(new Error("script exhausted"));
            }
            return [...next];
          }),
        streamText: () => Stream.die(new Error("not streamed")),
      }),
    ),
  );

const chargeCall = (id: string, cents: string) => ({
  type: "tool-call" as const,
  id,
  name: "charge",
  params: { cents, memo: "coffee" },
});

/**
 * One Configuration: Tools in its layer, its program wiring them. On `detach` the program forks a
 * Step that outlives the Turn and returns once `release` completes, while that Step may still ask.
 */
const configuration = (
  script: Script,
  dispatched: Array<unknown>,
  release: Effect.Effect<void> = Effect.void,
) => {
  const tools = Layer.effect(
    Tools,
    localTools(
      Kit,
      Kit.of({ charge: (params) => Effect.sync(() => (dispatched.push(params), "charged")) }),
    ),
  );
  return Mitome.make({
    agent: Agent.make({
      program: (message: string) =>
        Effect.gen(function* () {
          const turn = yield* Turn;
          yield* turn.stage(Prompt.userMessage({ content: [Prompt.textPart({ text: message })] }));
          const tools = yield* Tools;
          if (message === "detach") {
            yield* Effect.forkDetach(step({ tools }));
            yield* release;
            return { text: "detached" };
          }
          const result = yield* loop({ tools });
          return { text: result.response.text };
        }),
      text: {
        parse: Effect.succeed,
        render: (result) => Effect.succeed(result.text),
      },
    }),
    provide: tools,
    providers: [
      Provider.make("scripted", { modelIds: ["fixed"], provision: () => scriptedModel(script) }),
    ],
    model: "scripted/fixed",
  });
};

/** Waits, passively, until the channel shows a request. */
const nextPending = (pending: Effect.Effect<ReadonlyArray<PendingApproval>>) =>
  Effect.gen(function* () {
    // Bounded, so a Turn that never asks fails here rather than at the runner timeout.
    for (let poll = 0; poll < 200; poll++) {
      const [first] = yield* pending;
      if (first !== undefined) {
        return first;
      }
      yield* Effect.sleep(5);
    }
    return yield* Effect.die(new Error("No Approval request appeared"));
  });

describe(
  "makeApprovals as the Approver around a Configuration's Session",
  { timeout: 5000 },
  () => {
    it.live("shows the call as the Model sent it and dispatches it once only after approval", () =>
      Effect.gen(function* () {
        const dispatched: Array<unknown> = [];
        const config = configuration(
          [
            [chargeCall("c1", "250"), finish("tool-calls")],
            [text("done"), finish("stop")],
          ],
          dispatched,
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const instance = yield* config.acquire();
            const session = yield* instance.session();
            const channel = yield* makeApprovals;
            const turn = yield* Effect.forkChild(
              channel.provideApprover(session.run("buy coffee")),
            );
            const request = yield* nextPending(channel.pending);
            const pending = yield* channel.pending;
            expect(pending).toHaveLength(1);
            expect(pending[0]).toBe(request);
            const [running] = yield* session.turns;
            expect({ ...request, decide: undefined }).toEqual({
              turnId: running?.id,
              toolCallId: "c1",
              name: "charge",
              params: { cents: "250", memo: "coffee" },
              decide: undefined,
            });
            expect(dispatched).toEqual([]);
            expect(yield* request.decide("allow")).toBe("accepted");
            // The request is spent: repeating or reversing the decision changes nothing.
            expect(yield* request.decide("allow")).toBe("stale");
            expect(yield* request.decide("deny")).toBe("stale");
            const result = yield* Fiber.join(turn);
            expect(result.text).toBe("done");
            expect(dispatched).toHaveLength(1);
            // The handler received the value decoded from the JSON that was displayed.
            expect(dispatched).toEqual([{ cents: 250, memo: "coffee" }]);
            expect(yield* channel.pending).toEqual([]);
          }),
        );
      }),
    );

    it.live("never dispatches a denied call; the program continues with the denial as data", () =>
      Effect.gen(function* () {
        const dispatched: Array<unknown> = [];
        const config = configuration(
          [
            [chargeCall("c1", "250"), finish("tool-calls")],
            [text("ok, not charged"), finish("stop")],
          ],
          dispatched,
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const instance = yield* config.acquire();
            const session = yield* instance.session();
            const channel = yield* makeApprovals;
            const turn = yield* Effect.forkChild(
              channel.provideApprover(session.run("buy coffee")),
            );
            const request = yield* nextPending(channel.pending);
            expect(yield* request.decide("deny")).toBe("accepted");
            const result = yield* Fiber.join(turn);
            // Denial is not Turn failure: the Model is told and the Turn commits.
            expect(result.text).toBe("ok, not charged");
            expect(
              (yield* session.history).flatMap((message) =>
                message.role === "tool"
                  ? message.content.map((part) => part.type === "tool-result" && part.isFailure)
                  : [],
              ),
            ).toEqual([true]);
            expect(dispatched).toEqual([]);
            const [snapshot] = yield* session.turns;
            expect(snapshot?.phase).toBe("succeeded");
          }),
        );
      }),
    );

    it.live(
      "withdraws a request whose Turn is interrupted; a late decision dispatches nothing",
      () =>
        Effect.gen(function* () {
          const dispatched: Array<unknown> = [];
          const config = configuration(
            [[chargeCall("c1", "250"), finish("tool-calls")]],
            dispatched,
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const instance = yield* config.acquire();
              const session = yield* instance.session();
              const channel = yield* makeApprovals;
              const turn = yield* Effect.forkChild(
                channel.provideApprover(session.run("buy coffee")),
              );
              const request = yield* nextPending(channel.pending);
              yield* Fiber.interrupt(turn);
              expect(Exit.hasInterrupts(yield* Fiber.await(turn))).toBe(true);
              expect(yield* channel.pending).toEqual([]);
              expect(yield* request.decide("allow")).toBe("stale");
              expect(dispatched).toEqual([]);
              const [snapshot] = yield* session.turns;
              expect(snapshot?.phase).toBe("failed");
            }),
          );
        }),
    );

    it.live(
      "withdraws what an ended Turn's detached Step asked, so the next Turn can be answered",
      () =>
        Effect.gen(function* () {
          const dispatched: Array<unknown> = [];
          const release = yield* Deferred.make<void>();
          const config = configuration(
            [
              [chargeCall("c1", "100"), finish("tool-calls")],
              [chargeCall("c2", "250"), finish("tool-calls")],
              [text("done"), finish("stop")],
            ],
            dispatched,
            Deferred.await(release),
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const instance = yield* config.acquire();
              const session = yield* instance.session();
              const channel = yield* makeApprovals;
              const run = (input: string) => channel.provideApprover(session.run(input));
              const detached = yield* Effect.forkChild(run("detach"));
              const stale = yield* nextPending(channel.pending);
              expect(stale.toolCallId).toBe("c1");
              yield* Deferred.succeed(release, undefined);
              expect((yield* Fiber.join(detached)).text).toBe("detached");
              // The Turn has ended while its Step was still asking: nothing of it stays pending.
              expect(yield* channel.pending).toEqual([]);
              expect(yield* stale.decide("allow")).toBe("stale");

              const next = yield* Effect.forkChild(run("buy coffee"));
              const request = yield* nextPending(channel.pending);
              expect(request.toolCallId).toBe("c2");
              expect(yield* request.decide("allow")).toBe("accepted");
              expect((yield* Fiber.join(next)).text).toBe("done");
              expect(dispatched).toEqual([{ cents: 250, memo: "coffee" }]);
            }),
          );
        }),
    );

    it.live("a Turn that ends while a detached Step is starting to ask publishes nothing", () =>
      Effect.gen(function* () {
        const channel = yield* makeApprovals;
        const ended = yield* Deferred.make<void>();
        const scheduler = yield* Scheduler.Scheduler;
        let yielding = false;
        // Reading the call ends the Turn and makes the asking fiber yield right there, so the
        // Turn's revocation runs between the ask starting and its request being published.
        const call = {
          turnId: "t1",
          toolCallId: "c1",
          name: "charge",
          get params() {
            yielding = true;
            Deferred.doneUnsafe(ended, Effect.void);
            return { cents: 250, memo: "coffee" };
          },
        };
        const yieldOnRead: Scheduler.Scheduler = {
          executionMode: scheduler.executionMode,
          makeDispatcher: () => scheduler.makeDispatcher(),
          shouldYield: (fiber) => {
            if (!yielding) {
              return scheduler.shouldYield(fiber);
            }
            yielding = false;
            return true;
          },
        };
        const asking = yield* channel.provideApprover(
          Effect.gen(function* () {
            const approver = yield* Approver;
            if (approver === undefined) {
              return yield* Effect.die(new Error("no Approver"));
            }
            const asking = yield* Effect.forkDetach(
              approver.decide(call).pipe(Effect.provideService(Scheduler.Scheduler, yieldOnRead)),
            );
            yield* Deferred.await(ended);
            return asking;
          }),
        );
        const exit = yield* Fiber.await(asking).pipe(Effect.timeoutOption(1000));
        expect(yield* channel.pending).toEqual([]);
        expect(Option.isSome(exit) && Exit.hasInterrupts(exit.value)).toBe(true);
      }),
    );
  },
);
