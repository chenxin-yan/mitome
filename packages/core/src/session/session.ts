import { Cause, Context, Effect, Exit, Fiber, Queue, Scope } from "effect";
import type { Prompt } from "effect/unstable/ai";
import {
  SessionBusyError,
  SessionFencedError,
  SessionReleasedError,
  SessionSaveError,
} from "./errors.js";

/**
 * The active Turn, supplied to the program `Session.run` invokes. Ordinary nested functions that
 * yield it share that same Turn and Session; running work in another Session is an explicit `run`
 * call there, which supplies that Session's Turn for its duration only.
 */
export class Turn extends Context.Service<
  Turn,
  {
    /** Live identity of this Turn; not a durable receipt or an authorization token. */
    readonly id: string;
    /** The Session that owns this Turn. */
    readonly session: Session<unknown>;
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
   * when nothing was saved; any other failure or defect, including a `not-written` failure
   * combined with another reason, fences the Session.
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
   * still receives the typed value; `runWithReceipt` gives a typed read of the same outcome.
   */
  readonly exit?: Exit.Exit<unknown, unknown>;
}

/** A Turn snapshot as delivered to one observer, with how many snapshots it missed just before. */
export interface TurnObservation {
  readonly snapshot: TurnSnapshot;
  /** Snapshots not delivered to this observer, because its queue was full, since its last delivery. */
  readonly missed: number;
}

/** A finished Turn of a Session without persistence, from `runWithReceipt`. */
export interface TurnReceipt<out A, out E> {
  readonly id: string;
  /**
   * Reads this Turn's typed live outcome from its Session's records. Fails once the Session is
   * released; the receipt keeps neither the Session nor the outcome alive.
   */
  readonly read: Effect.Effect<
    { readonly id: string; readonly durability: "non-durable"; readonly exit: Exit.Exit<A, E> },
    SessionReleasedError
  >;
}

/** A live Session from `makeSession`; it lives until the Scope that allocated it closes. */
export interface Session<out PersistenceError = never> {
  /**
   * Runs one program as a whole-function Turn. The Turn supplies `Turn` and its own `Scope`; its
   * staged Messages publish once, after the program succeeds, its child fibers and the Turn Scope
   * have finished and any store save is confirmed. Child fibers are interrupted and awaited before
   * the Turn Scope closes; only a joined child's failure fails the Turn. Otherwise committed
   * history is unchanged, though completed external effects are not undone. Interrupting the
   * caller interrupts the Turn and waits for its cleanup; a save already under way still
   * completes, and if it succeeds the Turn is committed even though the caller sees the
   * interruption.
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
   * passive: when the observer's queue holds `capacity` undelivered snapshots, later ones are
   * dropped and counted in the next delivered `missed`, and a Turn never waits for an observer.
   * Closing the subscription is not cancellation, and it ends when the Session is released.
   * `turns` stays the authoritative record.
   */
  readonly observe: (
    capacity: number,
  ) => Effect.Effect<Queue.Dequeue<TurnObservation>, SessionReleasedError, Scope.Scope>;
}

/** A Session without persistence, whose Turns' live outcomes can also be read through receipts. */
export interface NonDurableSession extends Session {
  /**
   * Runs one program as a Turn exactly like `run`, but succeeds with a receipt for its outcome
   * whether the program succeeded or failed. Caller interruption still interrupts the Turn.
   */
  readonly runWithReceipt: <A, E, R>(
    program: Effect.Effect<A, E, R>,
  ) => Effect.Effect<
    TurnReceipt<A, E | SessionReleasedError>,
    SessionBusyError | SessionReleasedError,
    Exclude<R, Turn | Scope.Scope>
  >;
}

/** A Turn record, mutated only by its own Turn and dropped (with its outcome) on release. */
interface TurnRecord<A, E> {
  readonly id: string;
  phase: TurnSnapshot["phase"];
  exit?: Exit.Exit<A, E>;
}

const make = Effect.fn("@mitome/core/makeSession")(function* (store: SessionStore | undefined) {
  const executionScope = yield* Scope.make();
  // Each observer's queue, with how many snapshots it has missed since its last delivery.
  const observers = new Map<Queue.Queue<TurnObservation>, number>();
  let released = false;
  let busy = false;
  let fenced = false;
  let history: ReadonlyArray<Prompt.Message> = [];
  // ponytail: records are kept for the Session's lifetime; bound retention if Sessions run long.
  const turns = new Map<string, TurnRecord<unknown, unknown>>();

  // Reject new work before draining admitted Turns, then drop every live record.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      released = true;
      yield* Scope.close(executionScope, Exit.void);
      history = [];
      for (const record of turns.values()) delete record.exit;
      turns.clear();
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          for (const queue of observers.keys()) Queue.shutdownUnsafe(queue);
          observers.clear();
        }),
      ),
    ),
  );

  const snapshot = (record: TurnRecord<unknown, unknown>): TurnSnapshot =>
    record.exit === undefined
      ? { id: record.id, durability: "non-durable", phase: record.phase }
      : { id: record.id, durability: "non-durable", phase: record.phase, exit: record.exit };

  const whenLive = <A>(read: () => A) =>
    Effect.suspend(() => (released ? Effect.fail(new SessionReleasedError()) : Effect.sync(read)));

  /** Runs one Turn and returns its record and Exit, failing only when the Turn was not admitted. */
  const execute = <A, E, R>(program: Effect.Effect<A, E, R>) =>
    Effect.uninterruptibleMask((restoreCaller) =>
      Effect.gen(function* () {
        if (released) return yield* new SessionReleasedError();
        if (busy) return yield* new SessionBusyError();
        if (fenced) return yield* new SessionFencedError();
        busy = true;
        const record: TurnRecord<A, E | SessionReleasedError | SessionSaveError> = {
          id: crypto.randomUUID(),
          phase: "running",
        };
        turns.set(record.id, record);

        const turnFiber = Effect.uninterruptibleMask((restoreProgram) =>
          Effect.gen(function* () {
            let open = true;
            const staged: Array<Prompt.Message> = [];
            const turn = Turn.of({
              id: record.id,
              session: owner,
              stage: (...messages) =>
                Effect.suspend(() =>
                  open
                    ? Effect.sync(() => void staged.push(...messages))
                    : Effect.die(new Error("Turn is closed; its Messages can no longer be staged")),
                ),
            });
            // The program runs on its own fiber: a fiber interrupts and awaits its native children
            // before it completes, so joining it drains them before the Turn Scope closes.
            const result = yield* Effect.scopedWith((turnScope) =>
              Effect.gen(function* () {
                const body = yield* Effect.forkChild(
                  program.pipe(
                    Effect.provideContext(
                      Context.make(Turn, turn).pipe(Context.add(Scope.Scope, turnScope)),
                    ),
                  ),
                );
                return yield* restoreProgram(Fiber.join(body)).pipe(
                  Effect.ensuring(Fiber.interrupt(body)),
                );
              }),
            ).pipe(Effect.ensuring(Effect.sync(() => void (open = false))));
            // The Turn Scope has closed; observe any interruption that arrived during its cleanup.
            yield* restoreProgram(Effect.void);
            if (released) return yield* new SessionReleasedError();
            const next = [...history, ...staged];
            if (store !== undefined) {
              // ponytail: a save that never resolves blocks cancellation and release; deadlines are #170's.
              fenced = true;
              // Only a failure whose every reason is a definite not-written leaves nothing to reconcile.
              yield* store.save(next).pipe(
                Effect.tapCause((cause) =>
                  Effect.sync(() => {
                    fenced = !cause.reasons.every(
                      (reason) =>
                        Cause.isFailReason(reason) && reason.error.outcome === "not-written",
                    );
                  }),
                ),
              );
              fenced = false;
            }
            history = next;
            return result;
          }).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                record.phase = Exit.isSuccess(exit) ? "committed" : fenced ? "uncertain" : "failed";
                if (store === undefined) record.exit = exit;
                const delivered = snapshot(record);
                for (const [queue, missed] of observers) {
                  const offered = Queue.offerUnsafe(queue, { snapshot: delivered, missed });
                  observers.set(queue, offered ? 0 : missed + 1);
                }
              }),
            ),
          ),
        );

        // The Session's execution Scope owns the Turn so release drains it; the caller still waits.
        return yield* Effect.gen(function* () {
          const fiber = yield* Effect.forkIn(turnFiber, executionScope);
          const exit = yield* restoreCaller(Fiber.await(fiber)).pipe(
            Effect.ensuring(Fiber.interrupt(fiber)),
          );
          return { record, exit };
        }).pipe(Effect.ensuring(Effect.sync(() => void (busy = false))));
      }),
    );

  const session = {
    run: <A, E, R>(program: Effect.Effect<A, E, R>) =>
      execute(program).pipe(Effect.flatMap(({ exit }) => exit)),
    history: whenLive(() => history),
    turns: whenLive(() => Array.from(turns.values(), snapshot)),
    observe: (capacity: number) =>
      Effect.suspend(() => {
        if (!Number.isSafeInteger(capacity) || capacity < 1) {
          return Effect.die(new RangeError("Observer capacity must be a positive integer"));
        }
        if (released) return Effect.fail(new SessionReleasedError());
        return Effect.acquireRelease(
          Queue.dropping<TurnObservation>(capacity).pipe(
            Effect.tap((queue) => Effect.sync(() => void observers.set(queue, 0))),
          ),
          (queue) =>
            Effect.sync(() => {
              observers.delete(queue);
              Queue.shutdownUnsafe(queue);
            }),
        );
      }),
  };
  // Receipts read the Turn's own record, whose outcome is dropped when the Session is released.
  const runWithReceipt = <A, E, R>(program: Effect.Effect<A, E, R>) =>
    execute(program).pipe(
      Effect.map(({ record }) => ({
        id: record.id,
        read: Effect.suspend(() => {
          const exit = record.exit;
          return exit === undefined
            ? Effect.fail(new SessionReleasedError())
            : Effect.succeed({ id: record.id, durability: "non-durable" as const, exit });
        }),
      })),
    );
  const owner = store === undefined ? { ...session, runWithReceipt } : session;
  return owner;
});

/**
 * Allocates a fresh Session in the current Scope. Closing that Scope rejects new Turns,
 * interrupts and drains an active Turn (a save under way still completes) and then releases
 * every live record. Each call is a new Session; nothing is shared between them.
 */
export function makeSession(
  options: SessionOptions<"none">,
): Effect.Effect<NonDurableSession, never, Scope.Scope>;
export function makeSession(
  options: SessionOptions<SessionStore>,
): Effect.Effect<Session<SessionSaveError | SessionFencedError>, never, Scope.Scope>;
export function makeSession(
  options: SessionOptions<SessionStore | "none">,
): Effect.Effect<Session<SessionSaveError | SessionFencedError>, never, Scope.Scope> {
  return make(options.persistence === "none" ? undefined : options.persistence);
}
