import { describe, expect, it } from "@effect/vitest";
import { Cause, Context, Effect, Exit, Predicate, Schema, SchemaGetter, SchemaIssue } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { type ApprovalDecision, Approver } from "../../src/index.js";
import { localTools, Session, step } from "../../src/kernel.js";
import { call, scriptedModel } from "../support/step.js";

// Handler failure Causes through a controlled Step, as upstream Effect 4.1.6's Toolkit handles them.
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
    const session = yield* Session.make({ transcript: "none" });
    const tools = yield* localTools(kit, {
      write: ({ key }) =>
        Effect.suspend(() => (log.push(key), key === "a" ? fail() : Effect.succeed(key))),
    });
    const exit = yield* Effect.exit(
      session.run(
        step({ tools }).pipe(
          Effect.provide(scriptedModel([[call("a", "write"), call("b", "write")]], [])),
        ),
      ),
    );
    const results =
      Exit.isSuccess(exit) && Predicate.isTagged(exit.value, "Complete") ? exit.value.results : [];
    return { exit, log, results, history: yield* session.history };
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
      const { exit, log, results, history } = yield* runStep("return", () => Effect.fail(failure));
      expect(Exit.isSuccess(exit) && exit.value._tag).toBe("Complete");
      expect(log).toEqual(["a", "b"]);
      expect(results.map((part) => [part.id, part.isFailure])).toEqual([
        ["a", true],
        ["b", false],
      ]);
      expect(results[0]?.result).toBe(failure);
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

  // A defect takes precedence over a typed failure in the same Cause, so neither of these stays
  // failure data: the Step aborts before the second call and nothing is committed.
  it.effect("return mode: a typed failure whose own cleanup dies aborts the Step", () =>
    Effect.gen(function* () {
      const { exit, log, history } = yield* runStep("return", () =>
        Effect.fail(failure).pipe(Effect.ensuring(Effect.die(defect))),
      );
      expect(reasons(exit)).toEqual([
        ["Die", failure],
        ["Die", defect],
      ]);
      expect(log).toEqual(["a"]);
      expect(history).toEqual([]);
    }),
  );

  it.effect("return mode: a parameter decode failure whose finalizer dies aborts the Step", () =>
    Effect.gen(function* () {
      const invalid = new SchemaIssue.InvalidValue({ message: "rejected" });
      const Key = Schema.String.pipe(
        Schema.decodeTo(Schema.String, {
          decode: SchemaGetter.transformEffect((key: string) =>
            key === "a"
              ? Effect.fail(invalid).pipe(Effect.ensuring(Effect.die(defect)))
              : Effect.succeed(key),
          ),
          encode: SchemaGetter.passthrough(),
        }),
      );
      const kit = Toolkit.make(
        Tool.make("write", {
          parameters: Schema.Struct({ key: Key }),
          success: Schema.String,
          failureMode: "return",
        }),
      );
      const log: Array<string> = [];
      const session = yield* Session.make({ transcript: "none" });
      const tools = yield* localTools(kit, {
        write: ({ key }) => Effect.sync(() => (log.push(key), key)),
      });
      const exit = yield* Effect.exit(
        session.run(
          step({ tools }).pipe(
            Effect.provide(scriptedModel([[call("a", "write"), call("b", "write")]], [])),
          ),
        ),
      );
      expect(reasons(exit)).toEqual([
        ["Die", invalid],
        ["Die", defect],
      ]);
      expect(log).toEqual([]);
      expect(yield* session.history).toEqual([]);
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
  readonly approver?: () => Effect.Effect<ApprovalDecision, unknown>;
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
    const session = yield* Session.make({ transcript: "none" });
    const tools = yield* localTools(kit, {
      write: ({ key }) => Effect.sync(() => (log.push(key), key)),
    });
    const callbacks = gates();
    const exit = yield* Effect.exit(
      session.run(
        step({ tools, policy: only(callbacks.policy, "allow" as const) }).pipe(
          Effect.provide(scriptedModel([[call("a", "write"), call("b", "write")]], [])),
          Effect.provideService(Approver, {
            decide: (request) => {
              const approver = callbacks.approver;
              if (request.toolCallId !== "a" || approver === undefined) {
                return Effect.succeed("allow");
              }
              return approver();
            },
          }),
        ),
      ),
    );
    const results =
      Exit.isSuccess(exit) && Predicate.isTagged(exit.value, "Complete") ? exit.value.results : [];
    return { exit, log, results, history: yield* session.history };
  });

describe("authorization callback Causes through a controlled Step", () => {
  const cases = [
    ["policy", () => ({ policy: () => interruptedCleanup(Effect.fail("offline")) })],
    [
      "decide",
      () => ({
        policy: () => Effect.succeed("ask" as const),
        approver: () => interruptedCleanup(Effect.fail("offline")),
      }),
    ],
  ] as const;
  for (const [name, options] of cases) {
    it.effect(`a ${name} failure with an interrupted cleanup interrupts the Step`, () =>
      Effect.gen(function* () {
        const { exit, log, results, history } = yield* runGated(options);
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
        expect(log).toEqual([]);
        expect(results).toEqual([]);
        expect(history).toEqual([]);
      }),
    );
  }

  it.effect("an interrupted policy keeps every reason of its Cause, in order", () =>
    Effect.gen(function* () {
      const { exit, log, history } = yield* runGated(() => ({
        policy: () => interruptedCleanup(Effect.fail("offline"), true),
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

  it.effect("an interrupted policy keeps its failure's value identity and annotations", () =>
    Effect.gen(function* () {
      const Marker = Context.Reference<string>("step-causes/Marker", {
        defaultValue: () => "none",
      });
      const offline = { reason: "offline" };
      const { exit, log } = yield* runGated(() => ({
        policy: () =>
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

  it.effect("an interrupted policy defect propagates unchanged beside its interruption", () =>
    Effect.gen(function* () {
      const { exit, log } = yield* runGated(() => ({
        policy: () => Effect.die(defect).pipe(Effect.ensuring(Effect.interrupt)),
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

  it.effect("a pure policy interruption stays interruption only", () =>
    Effect.gen(function* () {
      const { exit, log } = yield* runGated(() => ({ policy: () => Effect.interrupt }));
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(log).toEqual([]);
    }),
  );

  it.effect("a failure with a cleanup defect but no interruption still denies", () =>
    Effect.gen(function* () {
      const { exit, log, results } = yield* runGated(() => ({
        policy: () => Effect.fail("offline").pipe(Effect.ensuring(Effect.die(defect))),
      }));
      expect(Exit.isSuccess(exit) && exit.value._tag).toBe("Complete");
      expect(log).toEqual(["b"]);
      expect(results.map((part) => [part.id, part.isFailure])).toEqual([
        ["a", true],
        ["b", false],
      ]);
    }),
  );
});
