import { Cause, Context, Effect, Exit, Fiber, Queue, Scope, Semaphore } from "effect";
import { Prompt, type Response, type Toolkit } from "effect/ai";
import {
  ExecutionLimitError,
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
    /** The Session that owns this Turn, with every persistence error a Session can raise. */
    readonly session: Session<SessionSaveError | SessionFencedError>;
    /**
     * Adds Messages to this Turn's staged conversation. They publish together only when the whole
     * Turn commits. Staging through a Turn after it closed is a defect.
     */
    readonly stage: (...messages: ReadonlyArray<Prompt.Message>) => Effect.Effect<void>;
    /**
     * What this root Turn's controlled Steps have consumed. It stays readable after the Turn ends,
     * while its Session lives, and fails once the Session is released.
     */
    readonly usage: Effect.Effect<ExecutionUsage, SessionReleasedError>;
  }
>()("@mitome/core/Turn") {}

/**
 * Finite bounds on one root Turn's controlled work. They are supplied policy, not Core constants:
 * a first-party composition passes `firstPartyExecutionLimits`, an embedding passes its own.
 */
export interface ExecutionLimits {
  /** Controlled Model generation calls, each reserved before its request whatever its outcome. */
  readonly generations: number;
  /** Local Tool handler dispatches, each reserved before the handler is entered. */
  readonly dispatches: number;
}

/** The first-party execution profile selected in the library plan. */
export const firstPartyExecutionLimits: ExecutionLimits = { generations: 64, dispatches: 256 };

/**
 * One root Turn's accounting. `physicalRequests` counts Provider requests the Model binding
 * reported for controlled generations, including its retries and native fallback; it has no bound.
 */
export interface ExecutionUsage {
  readonly generations: number;
  readonly dispatches: number;
  readonly physicalRequests: number;
}

/** The Tool registration a recorded outcome belongs to; reads select by its identity. */
export interface OutcomeOwner {
  readonly toolkit: Toolkit.Any;
}

/**
 * Controlled-Step access to a Turn; not part of the public Turn service. Every generation and
 * dispatch first reserves, and `reserve` is a defect once the Turn has ended or its Session is
 * released: a Turn handle that escaped its Turn authorizes nothing. Accounting of requests already
 * sent and outcomes already produced still records while the Session lives, and reads of the
 * records fail only after release.
 */
export interface TurnControl {
  /**
   * Runs one whole controlled Step while holding this Turn's single Step permit, so Steps of the
   * same Turn run one after another in arrival order. Waiting is interruptible and releases
   * nothing it never took.
   */
  readonly admit: <A, E, R>(step: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** The Model Prompt: committed history followed by this Turn's staged Messages. */
  readonly prompt: Effect.Effect<Prompt.Prompt>;
  /** Reserves one unit, failing without reserving when the bound is already reached. */
  readonly reserve: (limit: keyof ExecutionLimits) => Effect.Effect<void, ExecutionLimitError>;
  readonly addPhysicalRequests: (count: number) => Effect.Effect<void>;
  /** Records one completed local Tool result on this Turn's execution record, under `key`. */
  readonly recordOutcome: (key: OutcomeOwner, part: Response.AnyPart) => Effect.Effect<void>;
  /** The results recorded under `key`, oldest first. */
  readonly outcomes: (
    key: OutcomeOwner,
  ) => Effect.Effect<ReadonlyArray<Response.AnyPart>, SessionReleasedError>;
}

const turnControls = new WeakMap<Turn["Service"], TurnControl>();

/** The controlled-Step access of a Turn this module created. */
export const turnControl = (turn: Turn["Service"]): TurnControl => {
  const control = turnControls.get(turn);
  if (control === undefined) throw new Error("Turn was not created by makeSession");
  return control;
};

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
  /** Bounds applied to each of this Session's Turns. */
  readonly limits: ExecutionLimits;
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

/** A Turn snapshot as delivered to one observer. */
export interface TurnObservation {
  readonly snapshot: TurnSnapshot;
  /**
   * Position of this snapshot among those published since the observer subscribed, from 0. A jump
   * from the previous delivery, or a first delivery above 0, counts the snapshots it lost.
   */
  readonly sequence: number;
}

/** A finished Turn of a Session without persistence, from `runWithReceipt`. */
export interface TurnReceipt<out A, out E> {
  readonly id: string;
  /**
   * Reads this Turn's typed live outcome from its Session's records. Fails once the Session is
   * released or closing; the receipt keeps neither the Session nor the outcome alive.
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
   * have finished and any store save is confirmed. Child fibers the program forks are interrupted
   * and awaited before the Turn Scope closes, and those its cleanup forks before the Turn saves,
   * commits or returns and before the Session releases its dependencies. Turn Scope finalizers run
   * in native reverse order, so a finalizer must join any child that needs a resource a later
   * finalizer releases. Only a joined child's failure fails the Turn. Otherwise committed
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
   * passive: the observer's queue keeps the newest `capacity` undelivered snapshots, dropping the
   * oldest, and `sequence` gaps show what was lost; a Turn never waits for an observer. Closing the
   * subscription is not cancellation, and it ends when the Session is released. `turns` stays the
   * authoritative record.
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

/** A Turn record, mutated only by its own Turn and dropped (with its outcomes) on release. */
interface TurnRecord<A, E> {
  readonly id: string;
  phase: TurnSnapshot["phase"];
  exit?: Exit.Exit<A, E>;
  /** Completed local Tool results, each under the registration that dispatched it. */
  readonly outcomes: Array<{ readonly key: OutcomeOwner; readonly part: Response.AnyPart }>;
}

const make = Effect.fn("@mitome/core/makeSession")(function* (
  store: SessionStore | undefined,
  limits: ExecutionLimits,
) {
  if (![limits.generations, limits.dispatches].every((n) => Number.isSafeInteger(n) && n >= 0)) {
    return yield* Effect.die(new RangeError("Execution limits must be non-negative integers"));
  }
  const executionScope = yield* Scope.make();
  // Each observer's queue, with the sequence its next snapshot gets.
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
      for (const record of turns.values()) {
        delete record.exit;
        record.outcomes.length = 0;
      }
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
          outcomes: [],
        };
        turns.set(record.id, record);

        const turnFiber = Effect.uninterruptibleMask((restoreProgram) =>
          Effect.gen(function* () {
            let open = true;
            const staged: Array<Prompt.Message> = [];
            const used = { generations: 0, dispatches: 0, physicalRequests: 0 };
            const turn = Turn.of({
              id: record.id,
              session: owner,
              stage: (...messages) =>
                Effect.suspend(() =>
                  open
                    ? Effect.sync(() => void staged.push(...messages))
                    : Effect.die(new Error("Turn is closed; its Messages can no longer be staged")),
                ),
              usage: whenLive(() => ({ ...used })),
            });
            const closed = () =>
              Effect.die(new Error("Turn has ended; it authorizes no further controlled work"));
            const steps = Semaphore.makeUnsafe(1);
            turnControls.set(turn, {
              admit: (step) => steps.withPermits(1)(step),
              prompt: Effect.sync(() => Prompt.fromMessages([...history, ...staged])),
              reserve: (limit) =>
                Effect.suspend(() => {
                  if (!open || released) return closed();
                  if (used[limit] >= limits[limit]) {
                    return Effect.fail(new ExecutionLimitError({ limit, bound: limits[limit] }));
                  }
                  used[limit] += 1;
                  return Effect.void;
                }),
              addPhysicalRequests: (count) =>
                Effect.sync(() => void (used.physicalRequests += count)),
              recordOutcome: (key, part) =>
                Effect.sync(() => {
                  if (!released) record.outcomes.push({ key, part });
                }),
              outcomes: (key) =>
                whenLive(() =>
                  record.outcomes.filter((entry) => entry.key === key).map((entry) => entry.part),
                ),
            });
            // A fiber interrupts and awaits its native children before it completes. The program runs
            // on one fiber, joined before the Turn Scope closes, and the Turn Scope closes on another,
            // joined before save and publication, so children forked by the program or by its
            // cleanup both settle before the Turn commits.
            const owned = Effect.scopedWith((turnScope) =>
              Effect.gen(function* () {
                const body = yield* Effect.forkChild(
                  program.pipe(
                    Effect.provideContext(
                      Context.make(Turn, turn).pipe(Context.add(Scope.Scope, turnScope)),
                    ),
                  ),
                );
                return yield* Fiber.join(body).pipe(Effect.ensuring(Fiber.interrupt(body)));
              }),
            );
            const result = yield* Effect.gen(function* () {
              const cleanup = yield* Effect.forkChild(owned);
              return yield* restoreProgram(Fiber.join(cleanup)).pipe(
                Effect.ensuring(Fiber.interrupt(cleanup)),
              );
            }).pipe(Effect.ensuring(Effect.sync(() => void (open = false))));
            // The Turn Scope has closed; observe any interruption that arrived during its cleanup.
            yield* restoreProgram(Effect.void);
            if (released) return yield* new SessionReleasedError();
            const next = [...history, ...staged];
            if (store !== undefined) {
              // ponytail: a save that never resolves blocks cancellation and release; deadlines are #170's.
              fenced = true;
              // Only a failure with at least one reason, every one a definite not-written, leaves
              // nothing to reconcile.
              yield* store.save(next).pipe(
                Effect.tapCause((cause) =>
                  Effect.sync(() => {
                    fenced =
                      cause.reasons.length === 0 ||
                      !cause.reasons.every(
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
                for (const [queue, sequence] of observers) {
                  Queue.offerUnsafe(queue, { snapshot: delivered, sequence });
                  observers.set(queue, sequence + 1);
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
          Queue.sliding<TurnObservation>(capacity).pipe(
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
          return released || exit === undefined
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
  return make(options.persistence === "none" ? undefined : options.persistence, options.limits);
}
