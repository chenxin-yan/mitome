import { describe, expect, it } from "@effect/vitest";
import { Cause, Context, Data, Deferred, Effect, Exit, Fiber, PubSub, Scope } from "effect";
import { Prompt } from "effect/unstable/ai";
import {
  makeSession,
  SessionBusyError,
  SessionFencedError,
  SessionReleasedError,
  SessionSaveError,
  type SessionStore,
  Turn,
} from "../../src/index.js";

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

const recordingStore = () => {
  const saved: Array<ReadonlyArray<string>> = [];
  const store: SessionStore = {
    save: (history) => Effect.sync(() => void saved.push(texts(history))),
  };
  return { store, saved };
};

class Greeting extends Context.Service<Greeting, { readonly text: string }>()("test/Greeting") {}
class ApplicationFailure extends Data.TaggedError("ApplicationFailure") {}

describe("makeSession", () => {
  it.effect("runs an ordinary program and publishes its staged Messages once", () =>
    Effect.gen(function* () {
      const session = yield* makeSession({ persistence: "none" });
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
      const first = yield* makeSession({ persistence: "none" });
      const second = yield* makeSession({ persistence: "none" });
      yield* first.run(program());
      yield* second.run(stage("separate"));

      expect(texts(yield* first.history)).toEqual(["first", "second"]);
      expect(texts(yield* second.history)).toEqual(["separate"]);
    }),
  );

  it.effect("rejects a concurrent or nested Turn without committing either", () =>
    Effect.gen(function* () {
      const session = yield* makeSession({ persistence: "none" });
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
      const session = yield* Effect.scoped(makeSession({ persistence: "none" }));

      expect(yield* Effect.flip(session.run(program()))).toBeInstanceOf(SessionReleasedError);
      expect(yield* Effect.flip(session.history)).toBeInstanceOf(SessionReleasedError);
      expect(yield* Effect.flip(session.turns)).toBeInstanceOf(SessionReleasedError);
      expect(yield* Effect.flip(Effect.scoped(session.observe))).toBeInstanceOf(
        SessionReleasedError,
      );
    }),
  );

  it.effect("keeps committed history on body failure, defect or interruption", () =>
    Effect.gen(function* () {
      const session = yield* makeSession({ persistence: "none" });
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

  it.effect("does not commit when the Turn's own cleanup fails", () =>
    Effect.gen(function* () {
      const session = yield* makeSession({ persistence: "none" });
      const defect = new Error("own cleanup");
      for (const failBody of [false, true]) {
        const exit = yield* Effect.exit(
          session.run(
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() => Effect.die(defect));
              yield* program();
              if (failBody) return yield* new ApplicationFailure();
              return 42;
            }),
          ),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const reasons = exit.cause.reasons;
          expect(reasons.some((r) => Cause.isDieReason(r) && r.defect === defect)).toBe(true);
          expect(reasons.some(Cause.isFailReason)).toBe(failBody);
        }
      }

      expect(yield* session.history).toEqual([]);
      yield* session.run(program());
      expect(texts(yield* session.history)).toEqual(["first", "second"]);
    }),
  );

  it.effect("drains Turn resources and scoped fibers before publishing and returning", () =>
    Effect.gen(function* () {
      const session = yield* makeSession({ persistence: "none" });
      const childStarted = yield* Deferred.make<void>();
      const cleaning = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      let resourceLive = false;
      const invocation = yield* Effect.forkChild(
        session.run(
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.sync(() => void (resourceLive = true)),
              () => Effect.sync(() => void (resourceLive = false)),
            );
            yield* program();
            yield* Effect.forkScoped(
              Deferred.succeed(childStarted, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(
                  Deferred.succeed(cleaning, undefined).pipe(Effect.andThen(Deferred.await(gate))),
                ),
              ),
            );
            yield* Deferred.await(childStarted);
            return "done";
          }),
        ),
      );
      yield* Deferred.await(cleaning);

      expect(invocation.pollUnsafe()).toBeUndefined();
      expect(yield* session.history).toEqual([]);
      expect(yield* Effect.flip(session.run(program()))).toBeInstanceOf(SessionBusyError);
      yield* Deferred.succeed(gate, undefined);

      expect(yield* Fiber.join(invocation)).toBe("done");
      expect(resourceLive).toBe(false);
      expect(texts(yield* session.history)).toEqual(["first", "second"]);
    }),
  );

  it.effect("waits for held cleanup when the caller is interrupted, then saves nothing", () =>
    Effect.gen(function* () {
      const { store, saved } = recordingStore();
      const session = yield* makeSession({ persistence: store });
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
      expect(saved).toEqual([]);
      expect(yield* session.history).toEqual([]);
      yield* session.run(program());
      expect(saved).toEqual([["first", "second"]]);
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
        return yield* makeSession({ persistence: "none" });
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

  it.effect("composes an explicit Turn on another Session without sharing its commit", () =>
    Effect.gen(function* () {
      const parent = yield* makeSession({ persistence: "none" });
      const child = yield* makeSession({ persistence: "none" });
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

describe("makeSession with a SessionStore", () => {
  it.effect("saves the whole Turn before publishing it", () =>
    Effect.gen(function* () {
      const history: Array<ReadonlyArray<string>> = [];
      let read: Effect.Effect<ReadonlyArray<Prompt.Message>, SessionReleasedError> = Effect.succeed(
        [],
      );
      const session = yield* makeSession({
        persistence: {
          save: (next) =>
            Effect.gen(function* () {
              history.push(texts(yield* read.pipe(Effect.orDie)), texts(next));
            }),
        },
      });
      read = session.history;
      yield* session.run(stage("prior"));
      yield* session.run(program());

      expect(history).toEqual([[], ["prior"], ["prior"], ["prior", "first", "second"]]);
      expect(texts(yield* session.history)).toEqual(["prior", "first", "second"]);
    }),
  );

  it.effect("keeps history and stays usable when a save definitely wrote nothing", () =>
    Effect.gen(function* () {
      let calls = 0;
      const session = yield* makeSession({
        persistence: {
          save: () =>
            ++calls === 1
              ? Effect.fail(new SessionSaveError({ outcome: "not-written" }))
              : Effect.void,
        },
      });

      expect(yield* Effect.flip(session.run(program()))).toMatchObject({
        _tag: "SessionSaveError",
        outcome: "not-written",
      });
      expect(yield* session.history).toEqual([]);
      yield* session.run(stage("next"));
      expect(texts(yield* session.history)).toEqual(["next"]);
    }),
  );

  it.effect("fences the Session when a save outcome is unknown or the store dies", () =>
    Effect.gen(function* () {
      const external: Array<ReadonlyArray<string>> = [];
      const unknown = yield* makeSession({
        persistence: {
          save: (next) =>
            Effect.sync(() => void external.push(texts(next))).pipe(
              Effect.andThen(Effect.fail(new SessionSaveError({ outcome: "unknown" }))),
            ),
        },
      });
      expect(yield* Effect.flip(unknown.run(program()))).toMatchObject({ outcome: "unknown" });
      expect(yield* unknown.history).toEqual([]);
      expect(external).toEqual([["first", "second"]]);
      expect((yield* unknown.turns).map((turn) => turn.phase)).toEqual(["uncertain"]);
      expect(yield* Effect.flip(unknown.run(program()))).toBeInstanceOf(SessionFencedError);
      expect(external).toHaveLength(1);

      const defect = new Error("store defect");
      const dying = yield* makeSession({ persistence: { save: () => Effect.die(defect) } });
      const exit = yield* Effect.exit(dying.run(program()));
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(defect);
      expect(yield* Effect.flip(dying.run(program()))).toBeInstanceOf(SessionFencedError);
    }),
  );

  it.effect("commits a save already under way even though the caller was interrupted", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const session = yield* makeSession({
        persistence: {
          save: () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(gate))),
        },
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
      expect(turn).toEqual({ id: turn?.id, durability: "non-durable", phase: "committed" });
    }),
  );
});

describe("Session live queries", () => {
  it.effect("read non-durable live outcomes only while the Session lives", () =>
    Effect.gen(function* () {
      const allocation = yield* Scope.make();
      const session = yield* makeSession({ persistence: "none" }).pipe(
        Effect.provideService(Scope.Scope, allocation),
      );
      const result = yield* session.run(program());
      const failure = new ApplicationFailure();
      yield* Effect.flip(session.run(Effect.fail(failure)));

      const [committed, failed] = yield* session.turns;
      expect(committed).toMatchObject({ durability: "non-durable", phase: "committed" });
      expect(failed).toMatchObject({ durability: "non-durable", phase: "failed" });
      const committedExit = committed?.exit;
      const failedExit = failed?.exit;
      expect(committedExit && Exit.isSuccess(committedExit) && committedExit.value).toBe(result);
      expect(failedExit && Exit.isFailure(failedExit) && Cause.squash(failedExit.cause)).toBe(
        failure,
      );

      yield* Scope.close(allocation, Exit.void);
      expect(yield* Effect.flip(session.turns)).toBeInstanceOf(SessionReleasedError);
    }),
  );

  it.effect("keep observer delivery after publication and independent of the Turn", () =>
    Effect.gen(function* () {
      const { store, saved } = recordingStore();
      const session = yield* makeSession({ persistence: store });
      const idle = yield* session.observe;
      const observerScope = yield* Scope.make();
      const observer = yield* session.observe.pipe(
        Effect.provideService(Scope.Scope, observerScope),
      );
      const failingObserver = yield* Effect.forkChild(
        PubSub.take(observer).pipe(
          Effect.tap((snapshot) =>
            Effect.gen(function* () {
              expect(snapshot.phase).toBe("committed");
              expect(texts(yield* session.history)).toEqual(["first", "second"]);
            }),
          ),
          Effect.andThen(Effect.die(new Error("observer failed after commit"))),
        ),
      );

      expect(yield* session.run(program())).toEqual({ answer: 42 });
      expect(Exit.isFailure(yield* Fiber.await(failingObserver))).toBe(true);
      yield* Scope.close(observerScope, Exit.void);
      for (let turn = 0; turn < 20; turn++) yield* session.run(stage(String(turn)));

      expect(saved).toHaveLength(21);
      expect((yield* session.turns).every((turn) => turn.phase === "committed")).toBe(true);
      expect(yield* PubSub.takeAll(idle)).toHaveLength(16);
    }),
  );
});
