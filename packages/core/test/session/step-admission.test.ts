import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Predicate, Schema, Stream } from "effect";
import { LanguageModel, Tool, Toolkit } from "effect/ai";
import {
  firstPartyExecutionLimits as limits,
  localTools,
  makeSession,
  reportModelRequest,
  step,
  Turn,
  withModelRequestAccounting,
} from "../../src/index.js";
import { call, scriptedModel, text } from "../support/step.js";

// Owner-selected concurrency: complete controlled Steps of one Turn are admitted one at a time by a
// Turn-owned permit, and a Step's own callbacks cannot start another Step of that Turn.

const Write = Tool.make("write", {
  parameters: Schema.Struct({ key: Schema.String }),
  success: Schema.String,
});
const Soft = Tool.make("soft", {
  parameters: Schema.Struct({ key: Schema.String }),
  success: Schema.String,
  failureMode: "return",
});
const Kit = Toolkit.make(Write, Soft);

/** Handlers logging entry, exit and cleanup; `write:<hold>` waits on `gate`. */
const handlers = (
  log: Array<string>,
  hold: string,
  gate: Deferred.Deferred<void>,
  entered: Deferred.Deferred<void>,
) =>
  Kit.of({
    write: ({ key }) =>
      Effect.gen(function* () {
        log.push(`${key}:start`);
        if (key === hold) {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(gate);
        }
        log.push(`${key}:end`);
        return key;
      }).pipe(Effect.ensuring(Effect.sync(() => void log.push(`${key}:cleanup`)))),
    soft: ({ key }) => Effect.succeed(key),
  });

const turnUsage = Effect.gen(function* () {
  const turn = yield* Turn;
  return yield* turn.usage;
});

describe("controlled Step admission", () => {
  it.effect("runs a second Step only after the first, its cleanup and staging, finish", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const gate = yield* Deferred.make<void>();
      const entered = yield* Deferred.make<void>();
      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeSession({ persistence: "none", limits });
          const tools = yield* localTools(Kit, handlers(log, "a", gate, entered));
          return yield* session.run(
            Effect.gen(function* () {
              const first = yield* Effect.forkChild(step({ tools }));
              yield* Deferred.await(entered);
              const second = yield* Effect.forkChild(step({ tools }));
              // The second Step is queued: it has not built a Prompt or sent a request.
              for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
              const whileHeld = [...log];
              yield* Deferred.succeed(gate, undefined);
              yield* Fiber.join(first);
              yield* Fiber.join(second);
              return { whileHeld, usage: yield* turnUsage };
            }).pipe(
              Effect.provide(scriptedModel([[call("a", "write")], [call("b", "write")]], log)),
            ),
          );
        }),
      );
      expect(outcome.whileHeld).toEqual(["generate:0", "a:start"]);
      // The second Prompt includes the first Step's staged call and result.
      expect(log).toEqual([
        "generate:0",
        "a:start",
        "a:end",
        "a:cleanup",
        "generate:2",
        "b:start",
        "b:end",
        "b:cleanup",
      ]);
      expect(outcome.usage).toEqual({ generations: 2, dispatches: 2, physicalRequests: 2 });
    }),
  );

  it.effect("drops a queued Step that is interrupted before admission, with nothing sent", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const gate = yield* Deferred.make<void>();
      const entered = yield* Deferred.make<void>();
      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeSession({ persistence: "none", limits });
          const tools = yield* localTools(Kit, handlers(log, "a", gate, entered));
          return yield* session.run(
            Effect.gen(function* () {
              const first = yield* Effect.forkChild(step({ tools }));
              yield* Deferred.await(entered);
              const queued = yield* Effect.forkChild(step({ tools }));
              yield* Effect.yieldNow;
              yield* Fiber.interrupt(queued);
              const cancelled = yield* Fiber.await(queued);
              yield* Deferred.succeed(gate, undefined);
              yield* Fiber.join(first);
              return { cancelled, usage: yield* turnUsage };
            }).pipe(
              Effect.provide(scriptedModel([[call("a", "write")], [call("b", "write")]], log)),
            ),
          );
        }),
      );
      expect(
        Exit.isFailure(outcome.cancelled) && Cause.hasInterruptsOnly(outcome.cancelled.cause),
      ).toBe(true);
      expect(log).toEqual(["generate:0", "a:start", "a:end", "a:cleanup"]);
      expect(outcome.usage).toEqual({ generations: 1, dispatches: 1, physicalRequests: 1 });
    }),
  );

  it.effect(
    "drains the admitted Step and never admits the queued one when the Session is released",
    () =>
      Effect.gen(function* () {
        const log: Array<string> = [];
        const gate = yield* Deferred.make<void>();
        const entered = yield* Deferred.make<void>();
        yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* makeSession({ persistence: "none", limits });
            const tools = yield* localTools(Kit, handlers(log, "a", gate, entered));
            yield* Effect.forkChild(
              session.run(
                Effect.gen(function* () {
                  yield* Effect.forkChild(step({ tools }));
                  yield* Effect.forkChild(step({ tools }));
                  return yield* Effect.never;
                }).pipe(
                  Effect.provide(scriptedModel([[call("a", "write")], [call("b", "write")]], log)),
                ),
              ),
            );
            yield* Deferred.await(entered);
          }),
        );
        // Release interrupted the held handler, ran its cleanup and admitted nothing further.
        expect(log).toEqual(["generate:0", "a:start", "a:cleanup"]);
      }),
  );

  it.effect(
    "rejects a Step started from a Model, policy, consent, authority or handler callback",
    () =>
      Effect.gen(function* () {
        for (const via of ["model", "policy", "consent", "authority", "handler"] as const) {
          const log: Array<string> = [];
          const nestedLog: Array<string> = [];
          let captured: Turn["Service"] | undefined;
          // A Step of the same Turn, started from inside the running Step's callback.
          const nested = Effect.gen(function* () {
            log.push("nested");
            if (captured === undefined) return yield* Effect.die(new Error("no Turn"));
            return yield* step().pipe(
              Effect.provide(scriptedModel([[text("nested")]], nestedLog)),
              Effect.provideService(Turn, captured),
            );
          }).pipe(Effect.orDie);
          const model = withModelRequestAccounting(
            "reentrant",
            Layer.effect(
              LanguageModel.LanguageModel,
              LanguageModel.make({
                generateText: () =>
                  Effect.gen(function* () {
                    yield* reportModelRequest;
                    log.push("generate");
                    if (via === "model") yield* nested;
                    return log.filter((entry) => entry === "generate").length === 1
                      ? [call("c1", "soft")]
                      : [text("never")];
                  }),
                streamText: () => Stream.die(new Error("not streamed")),
              }),
            ),
          );
          const exit = yield* Effect.scoped(
            Effect.gen(function* () {
              const session = yield* makeSession({ persistence: "none", limits });
              const tools = yield* localTools(Kit, {
                write: ({ key }) => Effect.succeed(key),
                soft: ({ key }) =>
                  via === "handler"
                    ? Effect.andThen(nested, Effect.succeed(key))
                    : Effect.succeed(key),
              });
              const callback = <A>(value: A) =>
                via === "policy" || via === "consent" || via === "authority"
                  ? Effect.andThen(nested, Effect.succeed(value))
                  : Effect.succeed(value);
              return yield* Effect.exit(
                session.run(
                  Effect.gen(function* () {
                    captured = yield* Turn;
                    return yield* step({
                      tools,
                      policy: () =>
                        via === "policy"
                          ? callback("allow" as const)
                          : Effect.succeed("ask" as const),
                      consent: () => (via === "consent" ? callback(true) : Effect.succeed(true)),
                      authority: () =>
                        via === "authority" ? callback(true) : Effect.succeed(true),
                    });
                  }).pipe(Effect.provide(model)),
                ),
              );
            }),
          );
          // The nested Step started but never generated: it was rejected, not left waiting.
          expect(log.filter((entry) => entry === "generate")).toEqual(["generate"]);
          expect(log.includes("nested")).toBe(true);
          expect(nestedLog).toEqual([]);
          if (via === "model" || via === "handler") {
            // A rejected Step is a defect in the Model or handler, which stays a defect.
            expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
          } else {
            // Policy, consent and authority fail closed: the call is denied as failure data.
            const value = Exit.isSuccess(exit) ? exit.value : undefined;
            expect(value).toMatchObject({ _tag: "Complete", results: [{ isFailure: true }] });
          }
        }
      }),
  );

  it.effect("rejects a Step forked from the policy callback, without generating or waiting", () =>
    Effect.gen(function* () {
      const outer: Array<string> = [];
      const nested: Array<string> = [];
      const session = yield* makeSession({ persistence: "none", limits });
      const tools = yield* localTools(Kit, {
        write: ({ key }) => Effect.succeed(key),
        soft: ({ key }) => Effect.succeed(key),
      });
      let rejected = false;
      yield* session.run(
        step({
          tools,
          // A child fiber of the policy inherits the Step's same-Turn marker.
          policy: () =>
            Effect.gen(function* () {
              const child = yield* Effect.forkChild(
                step().pipe(Effect.provide(scriptedModel([[text("nested")]], nested))),
              );
              const exit = yield* Fiber.await(child);
              rejected = Exit.isFailure(exit) && Cause.hasDies(exit.cause);
              return "allow" as const;
            }),
        }).pipe(Effect.provide(scriptedModel([[call("a", "write")]], outer))),
      );
      expect(rejected).toBe(true);
      expect(nested).toEqual([]);
      expect(outer).toEqual(["generate:0"]);
    }),
  );

  it.effect("still runs a Step of an explicitly separate Session from a handler", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          const outer = yield* makeSession({ persistence: "none", limits });
          const inner = yield* makeSession({ persistence: "none", limits });
          const tools = yield* localTools(Kit, {
            write: ({ key }) =>
              inner
                .run(step().pipe(Effect.provide(scriptedModel([[text(`inner-${key}`)]], log))))
                .pipe(
                  Effect.map((result) =>
                    Predicate.isTagged(result, "Complete") ? result.response.text : "incomplete",
                  ),
                  Effect.orDie,
                ),
            soft: ({ key }) => Effect.succeed(key),
          });
          const result = yield* outer.run(
            step({ tools }).pipe(Effect.provide(scriptedModel([[call("x", "write")]], log))),
          );
          return { result, innerHistory: yield* inner.history };
        }),
      );
      if (!Predicate.isTagged(outcome.result, "Complete"))
        throw new Error("expected a complete Step");
      expect(outcome.result.results.map((part) => part.result)).toEqual(["inner-x"]);
      expect(outcome.innerHistory.map((message) => message.role)).toEqual(["assistant"]);
      expect(log).toEqual(["generate:0", "generate:0"]);
    }),
  );
});
