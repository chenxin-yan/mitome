import { describe, expect, it } from "@effect/vitest";
import { Cause, Context, Data, Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { Prompt } from "effect/ai";
import {
  SessionBusyError,
  SessionFencedError,
  SessionReleasedError,
  SessionSaveError,
  Turn,
} from "../../src/index.js";
import { Session } from "../../src/kernel.js";
import { recordingTranscript } from "../support/transcript.js";

const message = (text: string): Prompt.Message =>
  Prompt.userMessage({ content: [Prompt.textPart({ text })] });

/** An ordinary nested function: it shares whichever Turn its caller runs in. */
const stage = (text: string) =>
  Effect.gen(function* () {
    const turn = yield* Turn;
    yield* turn.stage(message(text));
    return turn.id;
  });

/** Stages two Messages through nested calls and returns an identity-bearing result. */
const program = () =>
  Effect.gen(function* () {
    yield* stage("first");
    yield* stage("second");
    return { answer: 42 };
  });

const texts = (history: ReadonlyArray<Prompt.Message>) =>
  history.map((entry) =>
    entry.role === "user" && entry.content[0]?.type === "text" ? entry.content[0].text : entry.role,
  );

const storedTexts = (stored: ReturnType<typeof recordingTranscript>["stored"]) =>
  Array.from(stored.entries.values(), (entry) => texts(entry.messages));

class Greeting extends Context.Service<Greeting, { readonly text: string }>()("test/Greeting") {}
class ApplicationFailure extends Data.TaggedError("ApplicationFailure") {}

describe("Session.make", () => {
  it.effect("runs an ordinary program and publishes its staged Messages once", () =>
    Effect.gen(function* () {
      const session = yield* Session.make({ transcript: "none" });
      const input = { topic: "blue" };
      const result = { input, invoke: (n: number) => n + 1 };
      const application = (value: typeof input) =>
        Effect.gen(function* () {
          const greeting = yield* Greeting;
          const first = yield* stage(greeting.text);
          const second = yield* stage(value.topic);
          expect(second).toBe(first);
          expect(yield* session.history).toEqual([]);
          return result;
        });

      const returned = yield* session
        .run(application(input))
        .pipe(Effect.provideService(Greeting, { text: "hello" }));

      expect(returned).toBe(result);
      expect(returned.input).toBe(input);
      expect(yield* session.history).toEqual([message("hello"), message("blue")]);
    }),
  );

  it.effect("allocates independent fresh Sessions", () =>
    Effect.gen(function* () {
      const first = yield* Session.make({ transcript: "none" });
      const second = yield* Session.make({ transcript: "none" });
      yield* first.run(program());
      yield* second.run(stage("separate"));

      expect(texts(yield* first.history)).toEqual(["first", "second"]);
      expect(texts(yield* second.history)).toEqual(["separate"]);
    }),
  );

  it.effect("rejects a concurrent or nested Turn without committing either", () =>
    Effect.gen(function* () {
      const session = yield* Session.make({ transcript: "none" });
      const started = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const active = yield* Effect.forkChild(
        session.run(
          stage("active").pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Deferred.await(gate)),
          ),
        ),
      );
      yield* Deferred.await(started);

      expect(yield* Effect.flip(session.run(program()))).toBeInstanceOf(SessionBusyError);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(active);
      expect(texts(yield* session.history)).toEqual(["active"]);

      const nested = stage("outer").pipe(Effect.andThen(session.run(program())));
      expect(yield* Effect.flip(session.run(nested))).toBeInstanceOf(SessionBusyError);
      expect(texts(yield* session.history)).toEqual(["active"]);
    }),
  );

  it.effect("rejects every use once its Scope is released", () =>
    Effect.gen(function* () {
      const session = yield* Effect.scoped(Session.make({ transcript: "none" }));

      expect(yield* Effect.flip(session.run(program()))).toBeInstanceOf(SessionReleasedError);
      expect(yield* Effect.flip(session.history)).toBeInstanceOf(SessionReleasedError);
      expect(yield* Effect.flip(session.turns)).toBeInstanceOf(SessionReleasedError);
    }),
  );

  it.effect("keeps committed history on body failure, defect or interruption", () =>
    Effect.gen(function* () {
      const session = yield* Session.make({ transcript: "none" });
      yield* session.run(stage("prior"));
      const failure = new ApplicationFailure();
      const failed = yield* Effect.flip(
        session.run(program().pipe(Effect.andThen(Effect.fail(failure)))),
      );
      expect(failed).toBe(failure);

      const defect = new Error("defect");
      const died = yield* Effect.exit(
        session.run(program().pipe(Effect.andThen(Effect.die(defect)))),
      );
      expect(Exit.isFailure(died) && Cause.squash(died.cause)).toBe(defect);

      const started = yield* Deferred.make<void>();
      let cleaned = false;
      const interrupted = yield* Effect.forkChild(
        session.run(
          program().pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Effect.never),
            Effect.ensuring(Effect.sync(() => void (cleaned = true))),
          ),
        ),
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(interrupted);
      expect(cleaned).toBe(true);

      expect(texts(yield* session.history)).toEqual(["prior"]);
      yield* session.run(stage("next"));
      expect(texts(yield* session.history)).toEqual(["prior", "next"]);
    }),
  );

  it.effect("settles a Turn whose caller is interrupted before the Turn starts", () =>
    Effect.gen(function* () {
      const session = yield* Session.make({ transcript: "none" });
      const caller = yield* Effect.forkChild(session.run(stage("lost")), {
        startImmediately: true,
      });
      yield* Fiber.interrupt(caller);
      yield* Effect.exit(session.run(stage("lost")).pipe(Effect.timeout(0)));
      yield* session.run(stage("next"));

      expect((yield* session.turns).map((turn) => turn.phase)).toEqual([
        "failed",
        "failed",
        "succeeded",
      ]);
      expect(texts(yield* session.history)).toEqual(["next"]);
    }),
  );

  it.effect("does not commit when the Turn's own cleanup fails", () =>
    Effect.gen(function* () {
      const session = yield* Session.make({ transcript: "none" });
      const defect = new Error("own cleanup");
      for (const failBody of [false, true]) {
        const exit = yield* Effect.exit(
          session.run(
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() => Effect.die(defect));
              yield* program();
              if (failBody) {
                return yield* new ApplicationFailure();
              }
              return 42;
            }),
          ),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const reasons = exit.cause.reasons;
          expect(reasons.some((r) => Cause.isDieReason(r) && r.defect === defect)).toBe(true);
          // A Cause that contains a defect keeps no typed failure: the body's failure is a defect too.
          expect(reasons.some(Cause.isFailReason)).toBe(false);
          expect(
            reasons.some((r) => Cause.isDieReason(r) && r.defect instanceof ApplicationFailure),
          ).toBe(failBody);
        }
      }

      expect(yield* session.history).toEqual([]);
      yield* session.run(program());
      expect(texts(yield* session.history)).toEqual(["first", "second"]);
    }),
  );

  it.effect(
    "drains native and scoped child fibers before Turn resources close and publication",
    () =>
      Effect.gen(function* () {
        const session = yield* Session.make({ transcript: "none" });
        const nativeCleaning = yield* Deferred.make<void>();
        const nativeGate = yield* Deferred.make<void>();
        const scopedCleaning = yield* Deferred.make<void>();
        const scopedGate = yield* Deferred.make<void>();
        let resourceLive = false;
        const resourceSeenByCleanup: Array<boolean> = [];
        const heldChild = (
          started: Deferred.Deferred<void>,
          cleaning: Deferred.Deferred<void>,
          gate: Deferred.Deferred<void>,
        ) =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Deferred.succeed(cleaning, undefined).pipe(
                Effect.andThen(Deferred.await(gate)),
                Effect.andThen(Effect.sync(() => void resourceSeenByCleanup.push(resourceLive))),
              ),
            ),
          );
        const invocation = yield* Effect.forkChild(
          session.run(
            Effect.gen(function* () {
              yield* Effect.acquireRelease(
                Effect.sync(() => void (resourceLive = true)),
                () => Effect.sync(() => void (resourceLive = false)),
              );
              yield* program();
              const nativeStarted = yield* Deferred.make<void>();
              const scopedStarted = yield* Deferred.make<void>();
              yield* Effect.forkChild(heldChild(nativeStarted, nativeCleaning, nativeGate));
              yield* Effect.forkScoped(heldChild(scopedStarted, scopedCleaning, scopedGate));
              yield* Deferred.await(nativeStarted);
              yield* Deferred.await(scopedStarted);
              return "done";
            }),
          ),
        );
        const assertUnsettled = Effect.gen(function* () {
          expect(invocation.pollUnsafe()).toBeUndefined();
          expect(resourceLive).toBe(true);
          expect(yield* session.history).toEqual([]);
          expect((yield* session.turns).map((turn) => turn.phase)).toEqual(["running"]);
          expect(yield* Effect.flip(session.run(program()))).toBeInstanceOf(SessionBusyError);
        });

        yield* Deferred.await(nativeCleaning);
        yield* assertUnsettled;
        yield* Deferred.succeed(nativeGate, undefined);
        yield* Deferred.await(scopedCleaning);
        yield* assertUnsettled;
        yield* Deferred.succeed(scopedGate, undefined);

        expect(yield* Fiber.join(invocation)).toBe("done");
        expect(resourceSeenByCleanup).toEqual([true, true]);
        expect(resourceLive).toBe(false);
        expect(texts(yield* session.history)).toEqual(["first", "second"]);
      }),
  );

  it.effect("drains a child forked by a Turn finalizer before publishing and returning", () =>
    Effect.gen(function* () {
      const session = yield* Session.make({ transcript: "none" });
      const started = yield* Deferred.make<void>();
      const cleaning = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const invocation = yield* Effect.forkChild(
        session.run(
          Effect.gen(function* () {
            yield* program();
            yield* Effect.addFinalizer(() =>
              Effect.forkChild(
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.ensuring(
                    Deferred.succeed(cleaning, undefined).pipe(
                      Effect.andThen(Deferred.await(gate)),
                    ),
                  ),
                ),
              ).pipe(Effect.andThen(Deferred.await(started))),
            );
            return "done";
          }),
        ),
      );
      yield* Deferred.await(cleaning);

      expect(invocation.pollUnsafe()).toBeUndefined();
      expect(yield* session.history).toEqual([]);
      expect((yield* session.turns).map((turn) => turn.phase)).toEqual(["running"]);
      expect(yield* Effect.flip(session.run(program()))).toBeInstanceOf(SessionBusyError);
      yield* Deferred.succeed(gate, undefined);

      expect(yield* Fiber.join(invocation)).toBe("done");
      expect(texts(yield* session.history)).toEqual(["first", "second"]);
    }),
  );

  it.effect("keeps a Turn-local resource for a child its finalizer joins", () =>
    Effect.gen(function* () {
      const session = yield* Session.make({ transcript: "none" });
      const cleaning = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      let resourceLive = false;
      const seenByChild: Array<boolean> = [];
      const invocation = yield* Effect.forkChild(
        session.run(
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.sync(() => void (resourceLive = true)),
              () => Effect.sync(() => void (resourceLive = false)),
            );
            yield* program();
            // Registered after the resource, so it runs first; joining keeps the resource open.
            yield* Effect.addFinalizer(() =>
              Effect.forkChild(
                Deferred.succeed(cleaning, undefined).pipe(
                  Effect.andThen(Deferred.await(gate)),
                  Effect.andThen(Effect.sync(() => void seenByChild.push(resourceLive))),
                ),
              ).pipe(Effect.flatMap(Fiber.join)),
            );
            return "done";
          }),
        ),
      );
      yield* Deferred.await(cleaning);

      expect(resourceLive).toBe(true);
      expect(invocation.pollUnsafe()).toBeUndefined();
      expect(yield* session.history).toEqual([]);
      yield* Deferred.succeed(gate, undefined);

      expect(yield* Fiber.join(invocation)).toBe("done");
      expect(seenByChild).toEqual([true]);
      expect(resourceLive).toBe(false);
      expect(texts(yield* session.history)).toEqual(["first", "second"]);
    }),
  );

  it.effect("keeps Session infrastructure until an unjoined cleanup child drains", () =>
    Effect.gen(function* () {
      const allocation = yield* Scope.make();
      const started = yield* Deferred.make<void>();
      const cleaning = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const order: Array<string> = [];
      let resourceLive = false;
      const session = yield* Effect.gen(function* () {
        yield* Effect.acquireRelease(Effect.void, () =>
          Effect.sync(() => void order.push("infrastructure released")),
        );
        return yield* Session.make({ transcript: "none" });
      }).pipe(Effect.provideService(Scope.Scope, allocation));
      const invocation = yield* Effect.forkChild(
        session.run(
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.sync(() => void (resourceLive = true)),
              () => Effect.sync(() => void (resourceLive = false)),
            );
            yield* program();
            yield* Effect.addFinalizer(() =>
              Effect.forkChild(
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.ensuring(
                    Deferred.succeed(cleaning, undefined).pipe(
                      Effect.andThen(Deferred.await(gate)),
                      Effect.andThen(Effect.sync(() => void order.push("child drained"))),
                    ),
                  ),
                ),
              ).pipe(Effect.andThen(Deferred.await(started))),
            );
            return "done";
          }),
        ),
      );
      yield* Deferred.await(cleaning);

      // Native LIFO order: the unjoined child outlives the resource a later finalizer released.
      expect(resourceLive).toBe(false);
      expect(invocation.pollUnsafe()).toBeUndefined();
      expect(yield* session.history).toEqual([]);
      const close = yield* Effect.forkChild(Scope.close(allocation, Exit.void), {
        startImmediately: true,
      });
      expect(yield* Effect.flip(session.run(program()))).toBeInstanceOf(SessionReleasedError);
      expect(close.pollUnsafe()).toBeUndefined();
      expect(order).toEqual([]);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(close);

      expect(order).toEqual(["child drained", "infrastructure released"]);
      expect(Exit.hasInterrupts(yield* Fiber.await(invocation))).toBe(true);
    }),
  );

  it.effect("commits Messages staged by the Turn's own cleanup with the Turn", () =>
    Effect.gen(function* () {
      const session = yield* Session.make({ transcript: "none" });
      yield* session.run(
        Effect.gen(function* () {
          const turn = yield* Turn;
          yield* Effect.addFinalizer(() => turn.stage(message("cleanup")));
          yield* program();
        }),
      );
      expect(texts(yield* session.history)).toEqual(["first", "second", "cleanup"]);

      const failed = yield* Effect.exit(
        session.run(
          Effect.gen(function* () {
            const turn = yield* Turn;
            yield* Effect.addFinalizer(() => turn.stage(message("discarded")));
            return yield* new ApplicationFailure();
          }),
        ),
      );
      expect(Exit.isFailure(failed)).toBe(true);
      expect(texts(yield* session.history)).toEqual(["first", "second", "cleanup"]);
    }),
  );

  it.effect("fails the Turn for a joined native child failure but not an unjoined one", () =>
    Effect.gen(function* () {
      const session = yield* Session.make({ transcript: "none" });
      const defect = new Error("child cleanup defect");
      const failingChild = Effect.void.pipe(Effect.ensuring(Effect.die(defect)));
      const joined = yield* Effect.exit(
        session.run(
          program().pipe(
            Effect.andThen(Effect.forkChild(failingChild)),
            Effect.flatMap(Fiber.join),
          ),
        ),
      );
      expect(Exit.isFailure(joined) && Cause.squash(joined.cause)).toBe(defect);
      expect(yield* session.history).toEqual([]);

      const started = yield* Deferred.make<void>();
      const unjoined = yield* session.run(
        Effect.gen(function* () {
          yield* program();
          const child = yield* Effect.forkChild(
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Effect.die(defect)),
            ),
          );
          yield* Deferred.await(started);
          return child;
        }),
      );
      const childExit = yield* Fiber.await(unjoined);
      expect(Exit.isFailure(childExit) && Cause.hasDies(childExit.cause)).toBe(true);
      expect(texts(yield* session.history)).toEqual(["first", "second"]);
    }),
  );

  it.effect("waits for held cleanup when the caller is interrupted, then stores nothing", () =>
    Effect.gen(function* () {
      const { transcript, stored } = recordingTranscript();
      const session = yield* Session.make({ transcript });
      const cleaning = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      let cleaned = false;
      const invocation = yield* Effect.forkChild(
        session.run(
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Deferred.succeed(cleaning, undefined).pipe(
                Effect.andThen(Deferred.await(gate)),
                Effect.andThen(Effect.sync(() => void (cleaned = true))),
              ),
            );
            return yield* program();
          }),
        ),
      );
      yield* Deferred.await(cleaning);
      const interrupt = yield* Effect.forkChild(Fiber.interrupt(invocation), {
        startImmediately: true,
      });
      expect(interrupt.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(interrupt);

      expect(cleaned).toBe(true);
      expect(storedTexts(stored)).toEqual([]);
      expect(yield* session.history).toEqual([]);
      yield* session.run(program());
      expect(storedTexts(stored)).toEqual([["first", "second"]]);
    }),
  );

  it.effect("drains an interrupted program and its child before its Turn resources close", () =>
    Effect.gen(function* () {
      const session = yield* Session.make({ transcript: "none" });
      const started = yield* Deferred.make<void>();
      const cleaning = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      let resourceLive = false;
      const seenByCleanup: Array<string> = [];
      const heldCleanup = (name: string) =>
        Deferred.succeed(cleaning, undefined).pipe(
          Effect.andThen(Deferred.await(gate)),
          Effect.andThen(Effect.sync(() => void seenByCleanup.push(`${name}:${resourceLive}`))),
        );
      const invocation = yield* Effect.forkChild(
        session.run(
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.sync(() => void (resourceLive = true)),
              () => Effect.sync(() => void (resourceLive = false)),
            );
            const childStarted = yield* Deferred.make<void>();
            yield* Effect.forkChild(
              Deferred.succeed(childStarted, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(heldCleanup("child")),
              ),
            );
            yield* Deferred.await(childStarted);
            yield* Deferred.succeed(started, undefined);
            return yield* Effect.never;
          }).pipe(Effect.ensuring(heldCleanup("program"))),
        ),
      );
      yield* Deferred.await(started);
      const interrupt = yield* Effect.forkChild(Fiber.interrupt(invocation), {
        startImmediately: true,
      });
      yield* Deferred.await(cleaning);

      expect(interrupt.pollUnsafe()).toBeUndefined();
      expect(resourceLive).toBe(true);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(interrupt);

      expect(seenByCleanup.toSorted()).toEqual(["child:true", "program:true"]);
      expect(resourceLive).toBe(false);
      expect(yield* session.history).toEqual([]);
    }),
  );

  it.effect("drains an active Turn before the Session's own dependencies are released", () =>
    Effect.gen(function* () {
      const allocation = yield* Scope.make();
      const started = yield* Deferred.make<void>();
      const cleaning = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const order: Array<string> = [];
      const session = yield* Effect.gen(function* () {
        yield* Effect.acquireRelease(Effect.void, () =>
          Effect.sync(() => void order.push("infrastructure released")),
        );
        return yield* Session.make({ transcript: "none" });
      }).pipe(Effect.provideService(Scope.Scope, allocation));
      let leaked: typeof Turn.Service | undefined;
      const invocation = yield* Effect.forkChild(
        session.run(
          Effect.gen(function* () {
            leaked = yield* Turn;
            yield* program();
            yield* Effect.addFinalizer(() =>
              Deferred.succeed(cleaning, undefined).pipe(
                Effect.andThen(Deferred.await(gate)),
                Effect.andThen(Effect.sync(() => void order.push("Turn drained"))),
              ),
            );
            yield* Deferred.succeed(started, undefined);
            return yield* Effect.never;
          }),
        ),
      );
      yield* Deferred.await(started);
      const close = yield* Effect.forkChild(Scope.close(allocation, Exit.void), {
        startImmediately: true,
      });
      yield* Deferred.await(cleaning);

      expect(yield* Effect.flip(session.run(program()))).toBeInstanceOf(SessionReleasedError);
      expect(close.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(close);

      expect(order).toEqual(["Turn drained", "infrastructure released"]);
      expect(Exit.hasInterrupts(yield* Fiber.await(invocation))).toBe(true);
      const late = yield* Effect.exit(leaked!.stage(message("late")));
      expect(Exit.isFailure(late) && Cause.hasDies(late.cause)).toBe(true);
    }),
  );

  it.effect("supplies the owning Session ambiently and restores it around another Session", () =>
    Effect.gen(function* () {
      /** Independently authored: reaches its Session only through the ambient Turn. */
      const ambient = Effect.gen(function* () {
        const turn = yield* Turn;
        return {
          session: turn.session,
          turnId: turn.id,
          history: texts(yield* turn.session.history),
        };
      });
      const parent = yield* Session.make({ transcript: "none" });
      const child = yield* Session.make({ transcript: "none" });
      yield* parent.run(stage("parent committed"));
      yield* child.run(stage("child committed"));

      const seen = yield* parent.run(
        Effect.gen(function* () {
          const before = yield* ambient;
          const nested = yield* stage("staged").pipe(Effect.andThen(ambient));
          const inside = yield* child.run(ambient.pipe(Effect.andThen(ambient)));
          const after = yield* ambient;
          return { before, nested, inside, after };
        }),
      );

      expect(seen.before.session).toBe(parent);
      expect(seen.nested).toEqual(seen.before);
      expect(seen.inside.session).toBe(child);
      expect(seen.inside.turnId).not.toBe(seen.before.turnId);
      expect(seen.inside.history).toEqual(["child committed"]);
      expect(seen.after).toEqual(seen.before);
      expect(seen.after.history).toEqual(["parent committed"]);
    }),
  );

  it.effect("composes an explicit Turn on another Session without sharing its commit", () =>
    Effect.gen(function* () {
      const parent = yield* Session.make({ transcript: "none" });
      const child = yield* Session.make({ transcript: "none" });
      const failure = new ApplicationFailure();
      const exit = yield* Effect.flip(
        parent.run(
          Effect.gen(function* () {
            yield* stage("parent");
            expect((yield* child.run(program())).answer).toBe(42);
            return yield* failure;
          }),
        ),
      );

      expect(exit).toBe(failure);
      expect(yield* parent.history).toEqual([]);
      expect(texts(yield* child.history)).toEqual(["first", "second"]);
    }),
  );
});

describe("Session.make with a Transcript", () => {
  it.effect("stores each Entry under the position before publishing it", () =>
    Effect.gen(function* () {
      const seen: Array<ReadonlyArray<string>> = [];
      let read: Effect.Effect<ReadonlyArray<Prompt.Message>, SessionReleasedError> = Effect.succeed(
        [],
      );
      const { transcript, stored } = recordingTranscript((entry) =>
        Effect.gen(function* () {
          seen.push(texts(yield* read.pipe(Effect.orDie)), texts(entry.messages));
        }),
      );
      const session = yield* Session.make({ transcript });
      read = session.history;
      yield* session.run(stage("prior"));
      const prior = yield* session.position;
      yield* session.run(program());

      expect(seen).toEqual([[], ["prior"], ["prior"], ["first", "second"]]);
      expect(stored.entries.get((yield* session.position) ?? "")?.parent).toBe(prior);
      expect(texts(yield* session.history)).toEqual(["prior", "first", "second"]);
    }),
  );

  it.effect("keeps history and stays usable when a commit definitely wrote nothing", () =>
    Effect.gen(function* () {
      let calls = 0;
      const { transcript } = recordingTranscript(() =>
        ++calls === 1 ? Effect.fail(new SessionSaveError({ outcome: "not-written" })) : Effect.void,
      );
      const session = yield* Session.make({ transcript });

      expect(yield* Effect.flip(session.run(program()))).toMatchObject({
        _tag: "SessionSaveError",
        outcome: "not-written",
      });
      expect(yield* session.history).toEqual([]);
      yield* session.run(stage("next"));
      expect(texts(yield* session.history)).toEqual(["next"]);
    }),
  );

  it.effect("fences the Session when a commit outcome is unknown or the Transcript dies", () =>
    Effect.gen(function* () {
      const external: Array<ReadonlyArray<string>> = [];
      const unknown = yield* Session.make({
        transcript: recordingTranscript((entry) =>
          Effect.sync(() => void external.push(texts(entry.messages))).pipe(
            Effect.andThen(Effect.fail(new SessionSaveError({ outcome: "unknown" }))),
          ),
        ).transcript,
      });
      expect(yield* Effect.flip(unknown.run(program()))).toMatchObject({ outcome: "unknown" });
      expect(yield* unknown.history).toEqual([]);
      expect(external).toEqual([["first", "second"]]);
      expect((yield* unknown.turns).map((turn) => turn.phase)).toEqual(["uncertain"]);
      expect(yield* Effect.flip(unknown.run(program()))).toBeInstanceOf(SessionFencedError);
      expect(external).toHaveLength(1);

      const defect = new Error("store defect");
      const dying = yield* Session.make({
        transcript: recordingTranscript(() => Effect.die(defect)).transcript,
      });
      const exit = yield* Effect.exit(dying.run(program()));
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(defect);
      expect(yield* Effect.flip(dying.run(program()))).toBeInstanceOf(SessionFencedError);
    }),
  );

  it.effect("fences unless every commit failure reason is a definite not-written failure", () =>
    Effect.gen(function* () {
      const notWritten = new SessionSaveError({ outcome: "not-written" });
      const compounds = [
        Cause.empty,
        Cause.combine(Cause.fail(notWritten), Cause.die(new Error("save cleanup defect"))),
        Cause.combine(
          Cause.fail(notWritten),
          Cause.fail(new SessionSaveError({ outcome: "unknown" })),
        ),
        Cause.fail(new SessionSaveError({ outcome: "conflict" })),
      ];
      for (const cause of compounds) {
        let saves = 0;
        const session = yield* Session.make({
          transcript: recordingTranscript(() =>
            Effect.suspend(() => (++saves, Effect.failCause(cause))),
          ).transcript,
        });
        const exit = yield* Effect.exit(session.run(program()));
        expect(exit).toStrictEqual(Exit.failCause(cause));
        expect((yield* session.turns).map((turn) => turn.phase)).toEqual(["uncertain"]);
        expect(yield* Effect.flip(session.run(program()))).toBeInstanceOf(SessionFencedError);
        expect(saves).toBe(1);
      }

      const twice = yield* Session.make({
        transcript: recordingTranscript(() =>
          Effect.failCause(Cause.combine(Cause.fail(notWritten), Cause.fail(notWritten))),
        ).transcript,
      });
      yield* Effect.exit(twice.run(program()));
      expect((yield* twice.turns).map((turn) => turn.phase)).toEqual(["failed"]);
      expect(yield* Effect.flip(twice.run(program()))).not.toBeInstanceOf(SessionFencedError);
    }),
  );

  it.effect("commits an Entry already under way even though the caller was interrupted", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const session = yield* Session.make({
        transcript: recordingTranscript(() =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(gate))),
        ).transcript,
      });
      const invocation = yield* Effect.forkChild(session.run(program()));
      yield* Deferred.await(entered);
      expect(yield* Effect.flip(session.run(program()))).toBeInstanceOf(SessionBusyError);
      const interrupt = yield* Effect.forkChild(Fiber.interrupt(invocation), {
        startImmediately: true,
      });
      expect(yield* session.history).toEqual([]);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(interrupt);

      expect(Exit.hasInterrupts(yield* Fiber.await(invocation))).toBe(true);
      expect(texts(yield* session.history)).toEqual(["first", "second"]);
      const [turn] = yield* session.turns;
      expect(turn).toEqual({
        id: turn?.id,
        phase: "succeeded",
        entries: [yield* session.position],
      });
    }),
  );
});

describe("Session live queries", () => {
  it.effect("read each Turn's phase and Entries only while the Session lives", () =>
    Effect.gen(function* () {
      const allocation = yield* Scope.make();
      const session = yield* Session.make({ transcript: "none" }).pipe(
        Effect.provideService(Scope.Scope, allocation),
      );
      yield* session.run(program());
      const failure = new ApplicationFailure();
      // The caller of `run` receives the typed failure; the record keeps only how the Turn ended.
      expect(yield* Effect.flip(session.run(Effect.fail(failure)))).toBe(failure);

      const [committed, failed] = yield* session.turns;
      expect(committed).toEqual({
        id: committed?.id,
        phase: "succeeded",
        entries: [yield* session.position],
      });
      expect(failed).toEqual({ id: failed?.id, phase: "failed", entries: [] });

      yield* Scope.close(allocation, Exit.void);
      expect(yield* Effect.flip(session.turns)).toBeInstanceOf(SessionReleasedError);
    }),
  );
});
