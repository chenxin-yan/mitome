import { Context, Effect, Exit, Fiber, PubSub, Scope } from "effect";
import type { Prompt } from "effect/unstable/ai";
import {
  SessionBusyError,
  SessionFencedError,
  SessionReleasedError,
  SessionSaveError,
} from "./errors.js";

/**
 * The active Turn, supplied to the program `Session.run` invokes. Ordinary nested functions that
 * yield it share that same Turn; running work in another Session is an explicit `run` call there.
 */
export class Turn extends Context.Service<
  Turn,
  {
    /** Live identity of this Turn; not a durable receipt or an authorization token. */
    readonly id: string;
    /**
     * Adds Messages to this Turn's staged conversation. They publish together only when the whole
     * Turn commits. Staging through a Turn after it closed is a defect.
     */
    readonly stage: (...messages: ReadonlyArray<Prompt.Message>) => Effect.Effect<void>;
  }
>()("@mitome/core/Turn") {}

/** Where a Session saves its next committed conversation before publishing it. */
export interface SessionStore {
  /**
   * Saves the full committed conversation a Turn is about to publish. Fail with `not-written` only
   * when nothing was saved; any other failure or defect fences the Session.
   */
  readonly save: (history: ReadonlyArray<Prompt.Message>) => Effect.Effect<void, SessionSaveError>;
}

/**
 * Persistence for `makeSession`: a `SessionStore`, or `"none"` to deliberately opt out. Without a
 * store nothing survives the Session and no result or Message codec is needed.
 */
export interface SessionOptions<Persistence extends SessionStore | "none"> {
  readonly persistence: Persistence;
}

/**
 * One Turn as recorded in its Session's memory. `committed` means history was published;
 * `failed` means it was not and committed history is unchanged; `uncertain` means the save outcome
 * is unknown. Records are never durable: they are dropped when the Session is released.
 */
export interface TurnSnapshot {
  readonly id: string;
  readonly durability: "non-durable";
  readonly phase: "running" | "committed" | "failed" | "uncertain";
  /**
   * The Turn's live result or failure, only on Sessions without persistence. The caller of `run`
   * still receives the typed value; this is an untyped read of the same outcome.
   */
  readonly exit?: Exit.Exit<unknown, unknown>;
}

/** A live Session from `makeSession`; it lives until the Scope that allocated it closes. */
export interface Session<out PersistenceError = never> {
  /**
   * Runs one program as a whole-function Turn. The Turn supplies `Turn` and its own `Scope`; its
   * staged Messages publish once, after the program succeeds, the Turn Scope (resources and scoped
   * fibers) has closed and any store save is confirmed. Otherwise committed history is unchanged,
   * though completed external effects are not undone. Interrupting the caller interrupts the Turn
   * and waits for its cleanup; a save already under way still completes, and if it succeeds the
   * Turn is committed even though the caller sees the interruption.
   */
  readonly run: <A, E, R>(
    program: Effect.Effect<A, E, R>,
  ) => Effect.Effect<
    A,
    E | SessionBusyError | SessionReleasedError | PersistenceError,
    Exclude<R, Turn | Scope.Scope>
  >;
  /** The committed conversation. */
  readonly history: Effect.Effect<ReadonlyArray<Prompt.Message>, SessionReleasedError>;
  /** Every Turn this Session has admitted, oldest first. */
  readonly turns: Effect.Effect<ReadonlyArray<TurnSnapshot>, SessionReleasedError>;
  /**
   * Subscribes to Turn snapshots as each Turn finishes, after any history publication. Delivery is
   * passive and bounded: a slow observer loses the oldest snapshots and never delays a Turn, and
   * closing the subscription is not cancellation. It ends when the Session is released.
   */
  readonly observe: Effect.Effect<
    PubSub.Subscription<TurnSnapshot>,
    SessionReleasedError,
    Scope.Scope
  >;
}

const make = Effect.fn("@mitome/core/makeSession")(function* (store: SessionStore | undefined) {
  // ponytail: fixed observer bound; make it configurable when bounded progress is specified.
  const observers = yield* PubSub.sliding<TurnSnapshot>(16);
  const executionScope = yield* Scope.make();
  let released = false;
  let busy = false;
  let fenced = false;
  let history: ReadonlyArray<Prompt.Message> = [];
  // ponytail: records are kept for the Session's lifetime; bound retention if Sessions run long.
  const turns = new Map<string, TurnSnapshot>();

  // Reject new work before draining admitted Turns, then drop every live record.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      released = true;
      yield* Scope.close(executionScope, Exit.void);
      history = [];
      turns.clear();
    }).pipe(Effect.ensuring(PubSub.shutdown(observers))),
  );

  const record = (id: string, phase: TurnSnapshot["phase"], exit?: Exit.Exit<unknown, unknown>) => {
    const snapshot: TurnSnapshot =
      store === undefined && exit !== undefined
        ? { id, durability: "non-durable", phase, exit }
        : { id, durability: "non-durable", phase };
    turns.set(id, snapshot);
    return snapshot;
  };

  const whenLive = <A>(read: () => A) =>
    Effect.suspend(() => (released ? Effect.fail(new SessionReleasedError()) : Effect.sync(read)));

  const run = <A, E, R>(program: Effect.Effect<A, E, R>) =>
    Effect.uninterruptibleMask((restoreCaller) =>
      Effect.gen(function* () {
        if (released) return yield* new SessionReleasedError();
        if (busy) return yield* new SessionBusyError();
        if (fenced) return yield* new SessionFencedError();
        busy = true;
        const id = crypto.randomUUID();
        record(id, "running");

        const execute = Effect.uninterruptibleMask((restoreProgram) =>
          Effect.gen(function* () {
            let open = true;
            const staged: Array<Prompt.Message> = [];
            const turn = Turn.of({
              id,
              stage: (...messages) =>
                Effect.suspend(() =>
                  open
                    ? Effect.sync(() => void staged.push(...messages))
                    : Effect.die(new Error("Turn is closed; its Messages can no longer be staged")),
                ),
            });
            const result = yield* Effect.scopedWith((turnScope) =>
              restoreProgram(
                program.pipe(
                  Effect.provideContext(
                    Context.make(Turn, turn).pipe(Context.add(Scope.Scope, turnScope)),
                  ),
                ),
              ).pipe(Effect.ensuring(Effect.sync(() => void (open = false)))),
            );
            // The Turn Scope has closed; observe any interruption that arrived during its cleanup.
            yield* restoreProgram(Effect.void);
            if (released) return yield* new SessionReleasedError();
            const next = [...history, ...staged];
            if (store !== undefined) {
              // ponytail: a save that never resolves blocks cancellation and release; deadlines are #170's.
              fenced = true;
              yield* store
                .save(next)
                .pipe(
                  Effect.tapError((error) =>
                    Effect.sync(() => void (fenced = error.outcome !== "not-written")),
                  ),
                );
              fenced = false;
            }
            history = next;
            return result;
          }).pipe(
            Effect.onExit((exit) =>
              PubSub.publish(
                observers,
                record(
                  id,
                  Exit.isSuccess(exit) ? "committed" : fenced ? "uncertain" : "failed",
                  exit,
                ),
              ),
            ),
          ),
        );

        // The Session's execution Scope owns the Turn so release drains it; the caller still waits.
        return yield* Effect.gen(function* () {
          const fiber = yield* Effect.forkIn(execute, executionScope);
          return yield* restoreCaller(Fiber.join(fiber)).pipe(
            Effect.ensuring(Fiber.interrupt(fiber)),
          );
        }).pipe(Effect.ensuring(Effect.sync(() => void (busy = false))));
      }),
    );

  return {
    run,
    history: whenLive(() => history),
    turns: whenLive(() => [...turns.values()]),
    observe: Effect.suspend(() =>
      released ? Effect.fail(new SessionReleasedError()) : PubSub.subscribe(observers),
    ),
  };
});

/**
 * Allocates a fresh Session in the current Scope. Closing that Scope rejects new Turns,
 * interrupts and drains an active Turn (a save under way still completes) and then releases
 * every live record. Each call is a new Session; nothing is shared between them.
 */
export function makeSession(
  options: SessionOptions<"none">,
): Effect.Effect<Session, never, Scope.Scope>;
export function makeSession(
  options: SessionOptions<SessionStore>,
): Effect.Effect<Session<SessionSaveError | SessionFencedError>, never, Scope.Scope>;
export function makeSession(
  options: SessionOptions<SessionStore | "none">,
): Effect.Effect<Session<SessionSaveError | SessionFencedError>, never, Scope.Scope> {
  return make(options.persistence === "none" ? undefined : options.persistence);
}
