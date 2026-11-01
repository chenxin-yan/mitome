import { describe, expect, it } from "@effect/vitest";
import { Cause, Context, Effect, Exit, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import {
  firstPartyExecutionLimits as limits,
  localTools,
  makeSession,
  step,
  toolOutcomes,
  Turn,
} from "../../src/index.js";
import { call, scriptedModel } from "../support/step.js";

// Handler failure Causes through a controlled Step, as upstream Effect 4.0.0's Toolkit handles them.
// The compositions come from running handler code.

class Failure extends Schema.TaggedError<Failure>()("StepCauseFailure", {}) {}
const kitFor = (failureMode: "error" | "return") =>
  Toolkit.make(
    Tool.make("write", {
      parameters: Schema.Struct({ key: Schema.String }),
      success: Schema.String,
      failure: Failure,
      failureMode,
    }),
  );
const failure = new Failure();
const defect = new Error("cleanup defect");
type Handler = () => Effect.Effect<string, Failure>;

/** One Step over calls `a` then `b`; `a` runs `fail`. */
const runStep = (failureMode: "error" | "return", fail: Handler) =>
  Effect.gen(function* () {
    const kit = kitFor(failureMode);
    const log: Array<string> = [];
    const session = yield* makeSession({ persistence: "none", limits });
    const tools = yield* localTools(kit, {
      write: ({ key }) =>
        Effect.suspend(() => (log.push(key), key === "a" ? fail() : Effect.succeed(key))),
    });
    let turn: Turn["Service"] | undefined;
    const exit = yield* Effect.exit(
      session.run(
        Effect.gen(function* () {
          turn = yield* Turn;
          return yield* step({ tools });
        }).pipe(Effect.provide(scriptedModel([[call("a", "write"), call("b", "write")]], []))),
      ),
    );
    if (turn === undefined) throw new Error("missing Turn");
    const recorded = yield* toolOutcomes(tools).pipe(Effect.provideService(Turn, turn));
    return { exit, log, recorded, history: yield* session.history };
  });

/** Each reason's tag and payload, in order. */
const reasons = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.map((reason) =>
        Cause.isFailReason(reason)
          ? ["Fail", reason.error]
          : Cause.isDieReason(reason)
            ? ["Die", reason.defect]
            : [reason._tag],
      )
    : [];

describe("handler failure Causes through a controlled Step", () => {
  it.effect("return mode: a lone typed failure stays failure data and the Step continues", () =>
    Effect.gen(function* () {
      const { exit, log, recorded, history } = yield* runStep("return", () => Effect.fail(failure));
      expect(Exit.isSuccess(exit) && exit.value._tag).toBe("Complete");
      expect(log).toEqual(["a", "b"]);
      expect(recorded.map((part) => [part.id, part.isFailure])).toEqual([
        ["a", true],
        ["b", false],
      ]);
      expect(recorded[0]?.result).toBe(failure);
      expect(history.map((message) => message.role)).toEqual(["assistant", "tool"]);
    }),
  );

  it.effect("error mode: a lone typed failure fails the Step with that failure", () =>
    Effect.gen(function* () {
      const { exit, log, history } = yield* runStep("error", () => Effect.fail(failure));
      expect(reasons(exit)).toEqual([["Fail", failure]]);
      expect(log).toEqual(["a"]);
      expect(history).toEqual([]);
    }),
  );
});

/** A callback outcome whose cleanup is interrupted, optionally after a cleanup defect. */
const interruptedCleanup = (outcome: Effect.Effect<never, string>, withDefect = false) =>
  (withDefect ? outcome.pipe(Effect.ensuring(Effect.die(defect))) : outcome).pipe(
    Effect.ensuring(Effect.interrupt),
  );

/** Authorization callbacks for call `a`; call `b` is always allowed. */
type Gates = {
  readonly policy?: () => Effect.Effect<"allow" | "ask" | "deny", unknown>;
  readonly consent?: () => Effect.Effect<boolean, unknown>;
  readonly authority?: () => Effect.Effect<boolean, unknown>;
};
const only =
  <A>(callback: (() => Effect.Effect<A, unknown>) | undefined, fallback: A) =>
  (request: { readonly toolCallId: string }) =>
    request.toolCallId === "a" && callback !== undefined ? callback() : Effect.succeed(fallback);

/** One return-mode Step over `a` then `b`, with authorization callbacks for `a` only. */
const runGated = (gates: () => Gates) =>
  Effect.gen(function* () {
    const kit = kitFor("return");
    const log: Array<string> = [];
    const session = yield* makeSession({ persistence: "none", limits });
    const tools = yield* localTools(kit, {
      write: ({ key }) => Effect.sync(() => (log.push(key), key)),
    });
    const callbacks = gates();
    let turn: Turn["Service"] | undefined;
    const exit = yield* Effect.exit(
      session.run(
        Effect.gen(function* () {
          turn = yield* Turn;
          return yield* step({
            tools,
            policy: only(callbacks.policy, "allow" as const),
            consent: only(callbacks.consent, true),
            authority: only(callbacks.authority, true),
          });
        }).pipe(Effect.provide(scriptedModel([[call("a", "write"), call("b", "write")]], []))),
      ),
    );
    if (turn === undefined) throw new Error("missing Turn");
    const recorded = yield* toolOutcomes(tools).pipe(Effect.provideService(Turn, turn));
    return { exit, log, recorded, history: yield* session.history };
  });

describe("authorization callback Causes through a controlled Step", () => {
  const cases = [
    ["policy", () => ({ policy: () => interruptedCleanup(Effect.fail("offline")) })],
    [
      "consent",
      () => ({
        policy: () => Effect.succeed("ask" as const),
        consent: () => interruptedCleanup(Effect.fail("offline")),
      }),
    ],
    ["authority", () => ({ authority: () => interruptedCleanup(Effect.fail("offline")) })],
  ] as const;
  for (const [name, options] of cases) {
    it.effect(`a ${name} failure with an interrupted cleanup interrupts the Step`, () =>
      Effect.gen(function* () {
        const { exit, log, recorded, history } = yield* runGated(options);
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
        expect(log).toEqual([]);
        expect(recorded).toEqual([]);
        expect(history).toEqual([]);
      }),
    );
  }

  it.effect("an interrupted authority keeps every reason of its Cause, in order", () =>
    Effect.gen(function* () {
      const { exit, log, history } = yield* runGated(() => ({
        authority: () => interruptedCleanup(Effect.fail("offline"), true),
      }));
      expect(
        Exit.isFailure(exit) &&
          exit.cause.reasons.map((reason) =>
            Cause.isDieReason(reason) ? ["Die", reason.defect] : [reason._tag],
          ),
      ).toEqual([["Die", "offline"], ["Die", defect], ["Interrupt"]]);
      expect(log).toEqual([]);
      expect(history).toEqual([]);
    }),
  );

  it.effect("an interrupted authority keeps its failure's value identity and annotations", () =>
    Effect.gen(function* () {
      const Marker = Context.Reference<string>("step-causes/Marker", {
        defaultValue: () => "none",
      });
      const offline = { reason: "offline" };
      const { exit, log } = yield* runGated(() => ({
        authority: () =>
          Effect.failCause(Cause.annotate(Cause.fail(offline), Context.make(Marker, "kept"))).pipe(
            Effect.ensuring(Effect.interrupt),
          ),
      }));
      const first = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined;
      expect(first !== undefined && Cause.isDieReason(first) && first.defect).toBe(offline);
      expect(first?.annotations.get(Marker.key)).toBe("kept");
      expect(Exit.isFailure(exit) && exit.cause.reasons.map((reason) => reason._tag)).toEqual([
        "Die",
        "Interrupt",
      ]);
      expect(log).toEqual([]);
    }),
  );

  it.effect("an interrupted authority defect propagates unchanged beside its interruption", () =>
    Effect.gen(function* () {
      const { exit, log } = yield* runGated(() => ({
        authority: () => Effect.die(defect).pipe(Effect.ensuring(Effect.interrupt)),
      }));
      expect(
        Exit.isFailure(exit) &&
          exit.cause.reasons.map((reason) =>
            Cause.isDieReason(reason) ? ["Die", reason.defect] : [reason._tag],
          ),
      ).toEqual([["Die", defect], ["Interrupt"]]);
      expect(log).toEqual([]);
    }),
  );

  it.effect("a pure authority interruption stays interruption only", () =>
    Effect.gen(function* () {
      const { exit, log } = yield* runGated(() => ({ authority: () => Effect.interrupt }));
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(log).toEqual([]);
    }),
  );

  it.effect("a failure with a cleanup defect but no interruption still denies", () =>
    Effect.gen(function* () {
      const { exit, log, recorded } = yield* runGated(() => ({
        authority: () => Effect.fail("offline").pipe(Effect.ensuring(Effect.die(defect))),
      }));
      expect(Exit.isSuccess(exit) && exit.value._tag).toBe("Complete");
      expect(log).toEqual(["b"]);
      expect(recorded.map((part) => [part.id, part.isFailure])).toEqual([
        ["a", true],
        ["b", false],
      ]);
    }),
  );
});
