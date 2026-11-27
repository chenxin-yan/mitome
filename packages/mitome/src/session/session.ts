import { Cause, Context, Effect, Exit, Fiber, Predicate, Result, Scope, Semaphore } from "effect";
import { Prompt } from "effect/ai";
import {
  ExecutionLimitError,
  SessionBusyError,
  SessionFencedError,
  SessionReleasedError,
  SessionSaveError,
  TranscriptError,
} from "./errors.js";
import { sessionOwnedWork, turnControls } from "./internal.js";
import { conversationMessage } from "./plain.js";
import { readLimits, Turn } from "./turn.js";
import type { ExecutionLimits } from "./turn.js";

/** The Messages committed together, under the Entry the conversation continued from. */
export interface Entry {
  readonly id: string;
  readonly parent: string | undefined;
  readonly messages: ReadonlyArray<Prompt.Message>;
}

/**
 * One conversation's storage: a tree of Entries and a stored position, the Entry the next commit
 * goes under. An adapter implements it; the kernel also has one in memory. Fail with `not-written`
 * only when nothing was stored and the position did not move, and with `conflict` when that is so
 * because the stored position was not `expected`. A Session stays usable only when every reason of
 * a failure is a `not-written` failure (or, from `select`, a `TranscriptError`); any other failure,
 * defect or interruption, alone or beside those, fences it.
 */
export interface Transcript {
  /** Names this conversation, so a Host can show it and open it again by it. */
  readonly id: string;
  /** The stored position and the Entries from the root to it, oldest first. */
  readonly open: Effect.Effect<
    { readonly position: string | undefined; readonly branch: ReadonlyArray<Entry> },
    TranscriptError
  >;
  /**
   * Stores `entry` and moves the position to it. Refuses, storing nothing, unless the stored
   * position is `expected`.
   */
  readonly append: (
    entry: Entry,
    expected: string | undefined,
  ) => Effect.Effect<void, SessionSaveError>;
  /**
   * Moves the position to an existing Entry (or to before the first, with `undefined`) and returns
   * its Branch, oldest first. Refuses like `append`; a `TranscriptError` moves nothing.
   */
  readonly select: (
    position: string | undefined,
    expected: string | undefined,
  ) => Effect.Effect<ReadonlyArray<Entry>, SessionSaveError | TranscriptError>;
  /** Every Entry's id and parent, for a navigation view. */
  readonly tree: Effect.Effect<
    ReadonlyArray<{ readonly id: string; readonly parent: string | undefined }>,
    TranscriptError
  >;
}

/**
 * Storage for `Session.make`: a `Transcript`, or `"none"` to keep the History tree in the Session's
 * memory. Without a Transcript nothing outlives the Session and no result or Message codec is needed.
 */
export interface SessionOptions<Storage extends Transcript | "none"> {
  readonly transcript: Storage;
  /** Bounds applied to each of this Session's Turns; without them a Turn has no limit. */
  readonly limits?: ExecutionLimits;
}

/**
 * One Turn as recorded in its Session's memory. `succeeded` and `failed` say how its program
 * ended; `uncertain` that one of its commits has an unknown outcome or was refused because another
 * writer moved the stored position, which fences the Session. `entries` are the ids this Turn
 * committed, oldest first, however it ended: not one per completed Step, since a Step with nothing
 * to commit adds none, and the Turn's own work is counted by its `usage`. A record keeps no result:
 * only the caller of `run` receives that. Records are never durable: they are dropped when the
 * Session is released.
 */
export interface TurnSnapshot {
  readonly id: string;
  readonly phase: "running" | "succeeded" | "failed" | "uncertain";
  readonly entries: ReadonlyArray<string>;
}

/** A live Session from `Session.make`; it lives until the Scope that allocated it closes. */
export interface Session<out PersistenceError = never> {
  /** The id of the Transcript this Session keeps its History tree in. */
  readonly transcript: string;
  /**
   * Runs one program as a whole-function Turn. The Turn supplies `Turn` and its own `Scope`. Each
   * controlled Step that completes commits the staged Messages, if there are any, as one Entry
   * under the position: the Transcript stores it, then history grows. Messages still staged when
   * the program succeeds and its child fibers and the Turn Scope have finished commit as a last
   * Entry; those still staged when it fails or is interrupted are dropped, and the Entries it
   * already committed stay. Nothing staged, no Entry.
   * Child fibers the program forks are interrupted and awaited before the Turn Scope closes, and
   * those its cleanup forks before the Turn commits its last Entry or returns and before the
   * Session releases its dependencies. Work a finalizer forks into the closing Turn Scope itself
   * (`Effect.forkScoped`) never starts, because that Scope is already closed, so it is not
   * covered: fork it as a child and join it instead. Turn Scope finalizers run in native reverse
   * order, so a finalizer must join any child that needs a resource a later finalizer releases.
   * Only a joined child's failure fails the Turn. Completed external effects are not undone.
   * Interrupting the caller interrupts the Turn and waits for its cleanup; a commit already under
   * way still completes, and if it succeeds its Entry stays even though the caller sees the
   * interruption.
   */
  readonly run: <A, E, R>(
    program: Effect.Effect<A, E, R>,
  ) => Effect.Effect<
    A,
    E | SessionBusyError | SessionReleasedError | PersistenceError,
    Exclude<R, Turn | Scope.Scope>
  >;
  /** The Messages of the current Branch, from the root to the position. */
  readonly history: Effect.Effect<ReadonlyArray<Prompt.Message>, SessionReleasedError>;
  /** The Entry the next commit goes under; `undefined` before the first. */
  readonly position: Effect.Effect<string | undefined, SessionReleasedError>;
  /**
   * Moves the position to an existing Entry, or with `undefined` to before the first, in the
   * Transcript and then here: `history` becomes that Branch and the next commit goes under it.
   * Refused while a Turn or another move runs; once started it completes even if interrupted, and
   * releasing the Session waits for it. A failed move fences the Session as a failed commit does,
   * except that a `TranscriptError` (no such Entry, or the Transcript cannot be read) moves
   * nothing and leaves it usable.
   */
  readonly moveTo: (
    position: string | undefined,
  ) => Effect.Effect<
    void,
    SessionBusyError | SessionReleasedError | TranscriptError | PersistenceError
  >;
  /**
   * Every Entry's id and parent in the Transcript, other Branches included. Releasing the Session
   * interrupts a read under way and waits for it.
   */
  readonly tree: Effect.Effect<
    ReadonlyArray<{ readonly id: string; readonly parent: string | undefined }>,
    SessionReleasedError | TranscriptError
  >;
  /** Every Turn this Session has admitted, oldest first. */
  readonly turns: Effect.Effect<ReadonlyArray<TurnSnapshot>, SessionReleasedError>;
}

/** A Turn record, mutated only by its own Turn and dropped on release. */
interface TurnRecord {
  readonly id: string;
  phase: TurnSnapshot["phase"];
  readonly entries: Array<string>;
}

const conflict = () => Effect.fail(new SessionSaveError({ outcome: "conflict" }));

/** A controlled Step or commit of a Turn that has already ended. */
const turnEnded = () =>
  Effect.die(new Error("Turn has ended; it authorizes no further controlled work"));

/**
 * The kernel's own Transcript, holding a Session's History tree in its memory, and how release
 * drops that tree.
 */
const memoryTranscript = () => {
  const entries = new Map<string, Entry>();
  let stored: string | undefined;
  const branch = (position: string | undefined) => {
    const found: Array<Entry> = [];
    for (let id = position; id !== undefined;) {
      const entry = entries.get(id);
      if (entry === undefined) {
        break;
      }
      found.unshift(entry);
      id = entry.parent;
    }
    return found;
  };
  const transcript: Transcript = {
    id: crypto.randomUUID(),
    open: Effect.sync(() => ({ position: stored, branch: branch(stored) })),
    append: (entry, expected) =>
      Effect.suspend(() => {
        if (expected !== stored) {
          return conflict();
        }
        entries.set(entry.id, entry);
        stored = entry.id;
        return Effect.void;
      }),
    select: (position, expected) =>
      Effect.suspend((): Effect.Effect<Array<Entry>, SessionSaveError | TranscriptError> => {
        if (expected !== stored) {
          return conflict();
        }
        if (position !== undefined && !entries.has(position)) {
          return Effect.fail(new TranscriptError({ detail: `no Entry "${position}"` }));
        }
        stored = position;
        return Effect.succeed(branch(position));
      }),
    tree: Effect.sync(() => Array.from(entries.values(), ({ id, parent }) => ({ id, parent }))),
  };
  return { transcript, clear: () => entries.clear() };
};

/**
 * A staged Message as the conversation keeps it. The conversation holds plain data, never live
 * objects: a Tool's schema turns a live value into data, and a store chooses its own format for
 * that data. So a Message is kept only if its encoded form is plain data, and without its absent
 * fields, which is what any store reads back; the kernel serialises nothing. Anything else is a
 * defect of its stager, named by role and place.
 */
const asStored = (message: Prompt.Message): Effect.Effect<Prompt.Message> =>
  conversationMessage(message).pipe(
    Effect.catchTag("NotPlainMessage", (issue) =>
      Effect.die(
        new Error(
          `A staged ${message.role} Message cannot be kept: ${issue.path} is ${issue.found}, not plain data`,
        ),
      ),
    ),
    Effect.catchTag("SchemaError", (error) =>
      Effect.die(
        new Error(
          `A staged ${message.role} Message cannot be kept: it does not decode without its absent fields`,
          { cause: error },
        ),
      ),
    ),
  );

const allocate = Effect.fn("mitome/Session.make")(function* (
  given: Transcript | undefined,
  options: ExecutionLimits = {},
) {
  // Snapshot so later changes to the caller's object cannot move a live Session's bounds.
  const read = readLimits(options);
  if (Result.isFailure(read)) {
    return yield* Effect.die(new RangeError(`Execution limits ${read.failure}`));
  }
  const limits = read.success;
  // One commit path: without a Transcript the tree lives in one the kernel keeps in memory.
  const memory = memoryTranscript();
  const transcript = given ?? memory.transcript;
  const opened = yield* transcript.open;
  let position = opened.position;
  let history: ReadonlyArray<Prompt.Message> = opened.branch.flatMap((entry) => entry.messages);
  const executionScope = yield* Scope.make();
  let released = false;
  let busy = false;
  let fenced = false;
  // One write to the Transcript at a time; holding it is how a Turn's end waits for a started one.
  const writes = Semaphore.makeUnsafe(1);
  // ponytail: each Turn's id, phase and Entry ids are kept for the Session's lifetime, never its
  // result; bound retention if Sessions run long.
  const turns = new Map<string, TurnRecord>();

  // Reject new work before draining admitted Turns, moves and reads, then drop every live record.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      released = true;
      yield* Scope.close(executionScope, Exit.void);
      history = [];
      memory.clear();
      turns.clear();
    }),
  );

  const snapshot = (record: TurnRecord): TurnSnapshot => ({
    id: record.id,
    phase: record.phase,
    entries: [...record.entries],
  });

  const whenLive = <A>(read: () => A) =>
    Effect.suspend(() => (released ? Effect.fail(new SessionReleasedError()) : Effect.sync(read)));

  /**
   * Runs one write to the Transcript with the Session fenced until it settles. The adapter is
   * called only once the fence is up, so a method that throws instead of returning an Effect is a
   * defect that leaves the Session fenced. Only a failure with at least one reason, every one a
   * definite not-written (or a missing Entry, which moves nothing), leaves nothing to reconcile.
   */
  const fencing = <A, E extends SessionSaveError | TranscriptError>(
    write: () => Effect.Effect<A, E>,
  ) =>
    Effect.suspend(() => {
      // ponytail: a write that never resolves blocks cancellation and release; deadlines are #170's.
      fenced = true;
      return Effect.suspend(write).pipe(
        Effect.tapCause((cause) =>
          Effect.sync(() => {
            fenced =
              cause.reasons.length === 0 ||
              !cause.reasons.every(
                (reason) =>
                  Cause.isFailReason(reason) &&
                  (Predicate.isTagged(reason.error, "TranscriptError") ||
                    reason.error.outcome === "not-written"),
              );
          }),
        ),
        Effect.tap(() => Effect.sync(() => void (fenced = false))),
      );
    });

  /**
   * Runs `effect` on a fiber the execution Scope owns, so release waits for it (and interrupts it
   * where it can be interrupted); the caller still waits for its result. Not started immediately:
   * the fiber must be in the Scope before an adapter call can resume a fiber that releases it.
   */
  const sessionOwned = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (released) {
          return yield* new SessionReleasedError();
        }
        const fiber = yield* Effect.forkIn(effect, executionScope);
        return yield* restore(Fiber.join(fiber)).pipe(Effect.ensuring(Fiber.interrupt(fiber)));
      }),
    );

  /** Runs one Turn and returns its Exit, failing only when the Turn was not admitted. */
  const execute = <A, E, R>(program: Effect.Effect<A, E, R>) =>
    Effect.uninterruptibleMask((restoreCaller) =>
      Effect.gen(function* () {
        if (released) {
          return yield* new SessionReleasedError();
        }
        if (busy) {
          return yield* new SessionBusyError();
        }
        if (fenced) {
          return yield* new SessionFencedError();
        }
        busy = true;
        const record: TurnRecord = {
          id: crypto.randomUUID(),
          phase: "running",
          entries: [],
        };
        turns.set(record.id, record);

        const turnFiber = Effect.uninterruptibleMask((restoreProgram) =>
          Effect.gen(function* () {
            let open = true;
            const staged: Array<Prompt.Message> = [];
            const used = { generations: 0, dispatches: 0, physicalRequests: 0 };
            const turn = Turn.of({
              id: record.id,
              session,
              stage: (...messages) => {
                const refused = Effect.die(
                  new Error("Turn is closed; its Messages can no longer be staged"),
                );
                return Effect.suspend(() =>
                  open
                    ? Effect.flatMap(Effect.forEach(messages, asStored), (kept) =>
                        // Checking a batch can yield, and the Turn can end meanwhile: staging
                        // succeeds only if the batch joined a Turn that was still open.
                        Effect.suspend(() => {
                          if (!open) {
                            return refused;
                          }
                          staged.push(...kept);
                          return Effect.void;
                        }),
                      )
                    : refused,
                );
              },
              usage: whenLive(() => ({ ...used })),
            });
            // Stores what is staged as one Entry under the position, then publishes it. Once
            // started it completes; Messages staged meanwhile stay staged for the next commit.
            // Nothing staged, no Entry: the History tree holds the conversation, and a Step's work
            // is counted on the Turn.
            const commit = (last: boolean) =>
              Effect.uninterruptible(
                writes.withPermits(1)(
                  Effect.suspend((): Effect.Effect<void, SessionSaveError | SessionFencedError> => {
                    // Checked holding the write permit, so the Turn's end has seen every Step commit.
                    if (!last && (!open || released)) {
                      return turnEnded();
                    }
                    if (staged.length === 0) {
                      return Effect.void;
                    }
                    if (fenced) {
                      return Effect.fail(new SessionFencedError());
                    }
                    const entry: Entry = {
                      id: crypto.randomUUID(),
                      parent: position,
                      messages: staged.slice(),
                    };
                    return fencing(() => transcript.append(entry, position)).pipe(
                      Effect.andThen(
                        Effect.sync(() => {
                          staged.splice(0, entry.messages.length);
                          history = [...history, ...entry.messages];
                          position = entry.id;
                          record.entries.push(entry.id);
                        }),
                      ),
                    );
                  }),
                ),
              );
            const steps = Semaphore.makeUnsafe(1);
            turnControls.set(turn, {
              // A Step of a fenced Session would work from a view that may be stale; refused before
              // its Model request. A definite not-written leaves no fence, so the next Step runs.
              admit: <A, E, R>(step: Effect.Effect<A, E, R>) =>
                steps.withPermits(1)(
                  Effect.suspend((): Effect.Effect<A, E | SessionFencedError, R> =>
                    fenced ? Effect.fail(new SessionFencedError()) : step,
                  ),
                ),
              prompt: Effect.sync(() => Prompt.fromMessages([...history, ...staged])),
              commit: commit(false),
              reserve: (limit) =>
                Effect.suspend(() => {
                  if (!open || released) {
                    return turnEnded();
                  }
                  const bound = limits[limit];
                  if (bound !== undefined && used[limit] >= bound) {
                    return Effect.fail(new ExecutionLimitError({ limit, bound }));
                  }
                  used[limit] += 1;
                  return Effect.void;
                }),
              addPhysicalRequests: (count) =>
                Effect.sync(() => void (used.physicalRequests += count)),
            });
            // A fiber interrupts and awaits its native children before it completes. The program runs
            // on one fiber, joined before the Turn Scope closes, and the Turn Scope closes on another,
            // joined before the last commit, so children forked by the program or by its cleanup
            // both settle before the Turn commits what is still staged.
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
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => void (open = false)).pipe(
                  // A commit a detached Step already started settles before the Turn's record.
                  Effect.andThen(writes.withPermits(1)(Effect.void)),
                ),
              ),
            );
            // The Turn Scope has closed; observe any interruption that arrived during its cleanup.
            yield* restoreProgram(Effect.void);
            if (released) {
              return yield* new SessionReleasedError();
            }
            yield* commit(true);
            return result;
          }).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                // Admission refuses a fenced Session, so a fence here is this Turn's.
                record.phase = fenced ? "uncertain" : Exit.isSuccess(exit) ? "succeeded" : "failed";
              }),
            ),
          ),
        );

        // The Session's execution Scope owns the Turn so release drains it; the caller still waits.
        // Starting immediately installs the Turn's exit handler before anything can interrupt it.
        return yield* Effect.gen(function* () {
          const fiber = yield* Effect.forkIn(turnFiber, executionScope, { startImmediately: true });
          const exit = yield* restoreCaller(Fiber.await(fiber)).pipe(
            Effect.ensuring(Fiber.interrupt(fiber)),
          );
          return exit;
        }).pipe(Effect.ensuring(Effect.sync(() => void (busy = false))));
      }),
    );

  const session = {
    transcript: transcript.id,
    run: <A, E, R>(program: Effect.Effect<A, E, R>) =>
      execute(program).pipe(Effect.flatMap((exit) => exit)),
    history: whenLive(() => history),
    position: whenLive(() => position),
    moveTo: (target: string | undefined) =>
      sessionOwned(
        Effect.uninterruptible(
          Effect.gen(function* () {
            if (busy) {
              return yield* new SessionBusyError();
            }
            if (fenced) {
              return yield* new SessionFencedError();
            }
            busy = true;
            const branch = yield* writes
              .withPermits(1)(fencing(() => transcript.select(target, position)))
              .pipe(Effect.ensuring(Effect.sync(() => void (busy = false))));
            history = branch.flatMap((entry) => entry.messages);
            position = target;
          }),
        ),
      ),
    // Read at each call: an adapter may compute its tree on access.
    tree: sessionOwned(Effect.suspend(() => transcript.tree)),
    turns: whenLive(() => Array.from(turns.values(), snapshot)),
  };
  sessionOwnedWork.set(session, sessionOwned);
  return session;
});

/**
 * Allocates a fresh Session in the current Scope, at the position its Transcript has stored (a new
 * in-memory one with `"none"`); a Transcript that cannot be opened fails it. Closing that Scope
 * rejects new Turns, interrupts and drains an active Turn (a commit under way still completes)
 * and then releases every live record. Each call is a new Session; Sessions opened on one
 * Transcript share only what it stores, and a stale one is fenced by its next commit.
 */
export function make(options: SessionOptions<"none">): Effect.Effect<Session, never, Scope.Scope>;
export function make(
  options: SessionOptions<Transcript>,
): Effect.Effect<Session<SessionSaveError | SessionFencedError>, TranscriptError, Scope.Scope>;
export function make(
  options: SessionOptions<Transcript | "none">,
): Effect.Effect<Session<SessionSaveError | SessionFencedError>, TranscriptError, Scope.Scope> {
  return allocate(options.transcript === "none" ? undefined : options.transcript, options.limits);
}
