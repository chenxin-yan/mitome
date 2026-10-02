import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Exit, Fiber, Layer, Queue, Schema } from "effect";
import { Prompt, Tool, Toolkit } from "effect/ai";
import {
  type Approvals,
  defineMitome,
  firstPartyExecutionLimits,
  type LocalTools,
  localTools,
  loop,
  makeApprovals,
  makeProvider,
  type PendingApproval,
  toolOutcomes,
  Turn,
} from "../src/index.js";
import { finish, type Script, scriptedModel, text } from "./support/step.js";

// Parameters that decode to something other than their wire form, so display and dispatch can be
// checked against the one decoded value.
const Charge = Tool.make("charge", {
  parameters: Schema.Struct({ cents: Schema.FiniteFromString, memo: Schema.String }),
  success: Schema.String,
  failureMode: "return",
  needsApproval: true,
});
const Kit = Toolkit.make(Charge);

class Channel extends Context.Service<Channel, Approvals>()("test/Approvals") {}
class Tools extends Context.Service<Tools, LocalTools<Toolkit.Tools<typeof Kit>>>()("test/Tools") {}

const chargeCall = (id: string, cents: string) => ({
  type: "tool-call" as const,
  id,
  name: "charge",
  params: { cents, memo: "coffee" },
});

/** One application: an Approval channel and Tools in its infrastructure, its program wiring them. */
const application = (
  script: Script,
  dispatched: Array<unknown>,
  authority: () => boolean = () => true,
) => {
  const channel = Layer.effect(Channel, makeApprovals);
  const tools = Layer.effect(
    Tools,
    localTools(
      Kit,
      Kit.of({ charge: (params) => Effect.sync(() => (dispatched.push(params), "charged")) }),
    ),
  );
  return defineMitome({
    program: (message: string) =>
      Effect.gen(function* () {
        const turn = yield* Turn;
        const approvals = yield* Channel;
        yield* turn.stage(Prompt.userMessage({ content: [Prompt.textPart({ text: message })] }));
        const tools = yield* Tools;
        const result = yield* loop({
          tools,
          consent: approvals.consent,
          authority: () => Effect.sync(authority),
        });
        return { text: result.response.text, outcomes: yield* toolOutcomes(tools) };
      }),
    limits: firstPartyExecutionLimits,
    infrastructure: Layer.mergeAll(channel, tools),
    providers: [makeProvider("scripted", ["fixed"], undefined, () => scriptedModel(script, []))],
    defaultModel: "scripted/fixed",
    cli: {
      parseInput: Effect.succeed,
      renderResult: (result) => Effect.succeed(result.text),
      approvals: Channel,
    },
  });
};

/** Waits, passively, until the channel shows a request. */
const nextPending = (pending: Effect.Effect<ReadonlyArray<PendingApproval>>) =>
  Effect.gen(function* () {
    for (;;) {
      const [first] = yield* pending;
      if (first !== undefined) return first;
      yield* Effect.sleep(1);
    }
  });

describe("makeApprovals through an application Session", () => {
  it.live("shows the exact decoded call and dispatches it once only after approval", () =>
    Effect.gen(function* () {
      const dispatched: Array<unknown> = [];
      const app = application(
        [
          [chargeCall("c1", "250"), finish("tool-calls")],
          [text("done"), finish("stop")],
        ],
        dispatched,
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const acquired = yield* app.acquire();
          const session = yield* acquired.session;
          const channel = yield* acquired.provide(app.cli!.approvals!);
          const turn = yield* Effect.forkChild(session.run("buy coffee"));
          const request = yield* nextPending(channel.pending);
          const [running] = yield* session.turns;
          expect({ ...request, decide: undefined }).toEqual({
            turnId: running?.id,
            toolCallId: "c1",
            name: "charge",
            params: { cents: 250, memo: "coffee" },
            decide: undefined,
          });
          expect(dispatched).toEqual([]);
          expect(yield* request.decide("approve")).toBe("accepted");
          // The request is spent: repeating or reversing the decision changes nothing.
          expect(yield* request.decide("approve")).toBe("stale");
          expect(yield* request.decide("deny")).toBe("stale");
          const result = yield* Fiber.join(turn);
          expect(result.text).toBe("done");
          expect(dispatched).toHaveLength(1);
          // The handler received the very value that was displayed.
          expect(dispatched[0]).toBe(request.params);
          expect(yield* channel.pending).toEqual([]);
        }),
      );
    }),
  );

  it.live("never dispatches a denied call; the program continues with the denial as data", () =>
    Effect.gen(function* () {
      const dispatched: Array<unknown> = [];
      const app = application(
        [
          [chargeCall("c1", "250"), finish("tool-calls")],
          [text("ok, not charged"), finish("stop")],
        ],
        dispatched,
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const acquired = yield* app.acquire();
          const session = yield* acquired.session;
          const channel = yield* acquired.provide(app.cli!.approvals!);
          const turn = yield* Effect.forkChild(session.run("buy coffee"));
          const request = yield* nextPending(channel.pending);
          expect(yield* request.decide("deny")).toBe("accepted");
          const result = yield* Fiber.join(turn);
          // Denial is not Turn failure here: the return-mode Tool reports it and the Turn commits.
          expect(result.text).toBe("ok, not charged");
          expect(result.outcomes.map((part) => part.isFailure)).toEqual([true]);
          expect(dispatched).toEqual([]);
          const [snapshot] = yield* session.turns;
          expect(snapshot?.phase).toBe("committed");
        }),
      );
    }),
  );

  it.live("withdraws a request whose Turn is interrupted; a late decision dispatches nothing", () =>
    Effect.gen(function* () {
      const dispatched: Array<unknown> = [];
      const app = application([[chargeCall("c1", "250"), finish("tool-calls")]], dispatched);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const acquired = yield* app.acquire();
          const session = yield* acquired.session;
          const channel = yield* acquired.provide(app.cli!.approvals!);
          const turn = yield* Effect.forkChild(session.run("buy coffee"));
          const request = yield* nextPending(channel.pending);
          yield* Fiber.interrupt(turn);
          expect(yield* channel.pending).toEqual([]);
          expect(yield* request.decide("approve")).toBe("stale");
          expect(dispatched).toEqual([]);
          const [snapshot] = yield* session.turns;
          expect(snapshot?.phase).toBe("failed");
          expect(snapshot?.exit !== undefined && Exit.hasInterrupts(snapshot.exit)).toBe(true);
        }),
      );
    }),
  );

  it.live("an approval grants consent, not authority: a revoked call is still not dispatched", () =>
    Effect.gen(function* () {
      const dispatched: Array<unknown> = [];
      const app = application(
        [
          [chargeCall("c1", "250"), finish("tool-calls")],
          [text("revoked"), finish("stop")],
        ],
        dispatched,
        () => false,
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const acquired = yield* app.acquire();
          const session = yield* acquired.session;
          const channel = yield* acquired.provide(app.cli!.approvals!);
          const turn = yield* Effect.forkChild(session.run("buy coffee"));
          const request = yield* nextPending(channel.pending);
          expect(yield* request.decide("approve")).toBe("accepted");
          const result = yield* Fiber.join(turn);
          expect(result.outcomes.map((part) => part.isFailure)).toEqual([true]);
          expect(dispatched).toEqual([]);
        }),
      );
    }),
  );

  it.live("runs repeated Turns whatever a stopped observer does", () =>
    Effect.gen(function* () {
      const dispatched: Array<unknown> = [];
      const app = application(
        [
          [text("one"), finish("stop")],
          [text("two"), finish("stop")],
          [text("three"), finish("stop")],
        ],
        dispatched,
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const acquired = yield* app.acquire();
          const session = yield* acquired.session;
          // A capacity-1 subscription nobody reads: it keeps the newest snapshot and drops the rest.
          const ignored = yield* session.observe(1);
          const replies = [
            (yield* session.run("a")).text,
            (yield* session.run("b")).text,
            (yield* session.run("c")).text,
          ];
          expect(replies).toEqual(["one", "two", "three"]);
          const turns = yield* session.turns;
          expect(turns.map((turn) => turn.phase)).toEqual(["committed", "committed", "committed"]);
          expect(yield* session.history).toHaveLength(6);
          // Only the newest delivery remains; the record above is authoritative regardless.
          const [kept] = yield* Queue.takeAll(ignored);
          expect(kept.snapshot.id).toBe(turns[2]?.id);
        }),
      );
    }),
  );
});
