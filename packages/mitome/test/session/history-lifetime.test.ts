import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { Prompt } from "effect/ai";
import { SessionFencedError, SessionSaveError, Turn } from "../../src/index.js";
import { Session, step } from "../../src/kernel.js";
import { finish, scriptedModel, text } from "../support/step.js";
import { recordingTranscript } from "../support/transcript.js";

// Review corrections: a write the Session started settles before anything that depends on it
// (the Turn's record, release, the next Step), and an adapter that throws is still fenced.

const user = (value: string) =>
  Effect.gen(function* () {
    const turn = yield* Turn;
    yield* turn.stage(Prompt.userMessage({ content: [Prompt.textPart({ text: value })] }));
  });

/** Lets every fiber that can run do so, without a clock. */
const settle = Effect.gen(function* () {
  for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
});

describe("Session writes and the lifetime around them", () => {
  it.effect("finishes a Turn only after a commit its detached Step started", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const { transcript, stored } = recordingTranscript(() =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(gate))),
      );
      const session = yield* Session.make({ transcript });
      const running = yield* Effect.forkChild(
        session.run(
          Effect.gen(function* () {
            yield* user("go");
            yield* Effect.forkDetach(step().pipe(Effect.provide(scriptedModel([[text("a")]], []))));
            yield* Deferred.await(entered);
            return "done";
          }),
        ),
      );
      yield* Deferred.await(entered);
      yield* settle;
      yield* Deferred.succeed(gate, undefined);

      expect(yield* Fiber.join(running)).toBe("done");
      const [snapshot] = yield* session.turns;
      expect(snapshot?.phase).toBe("succeeded");
      expect(snapshot?.entries).toEqual(Array.from(stored.entries.keys()));
      expect(stored.entries.size).toBe(1);
    }),
  );

  it.effect("refuses a Step of a fenced Session before its Model request", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const { transcript } = recordingTranscript(() =>
        Effect.fail(new SessionSaveError({ outcome: "unknown" })),
      );
      const session = yield* Session.make({ transcript });
      yield* Effect.exit(
        session.run(
          Effect.gen(function* () {
            yield* user("go");
            expect(yield* Effect.flip(step())).toMatchObject({ outcome: "unknown" });
            expect(yield* Effect.flip(step())).toBeInstanceOf(SessionFencedError);
          }).pipe(Effect.provide(scriptedModel([[text("a")], [text("b")]], log))),
        ),
      );
      expect(log).toEqual(["generate:1"]);

      // A definite not-written leaves the Session usable, so the next Step runs.
      let refuse = 1;
      const usable = yield* Session.make({
        transcript: recordingTranscript(() =>
          refuse-- > 0
            ? Effect.fail(new SessionSaveError({ outcome: "not-written" }))
            : Effect.void,
        ).transcript,
      });
      const retried: Array<string> = [];
      yield* usable.run(
        Effect.gen(function* () {
          yield* user("go");
          expect(yield* Effect.flip(step())).toMatchObject({ outcome: "not-written" });
          yield* step();
        }).pipe(Effect.provide(scriptedModel([[text("a")], [text("b")]], retried))),
      );
      expect(retried).toEqual(["generate:1", "generate:2"]);
    }),
  );

  it.effect("fences the Session when an adapter method throws before returning an Effect", () =>
    Effect.gen(function* () {
      const defect = new Error("adapter threw");
      const { transcript } = recordingTranscript();
      const throwing = yield* Session.make({
        transcript: {
          ...transcript,
          append: () => {
            throw defect;
          },
        },
      });
      const appended = yield* Effect.exit(throwing.run(user("go")));
      expect(Exit.isFailure(appended) && Cause.squash(appended.cause)).toBe(defect);
      expect(yield* Effect.flip(throwing.run(user("again")))).toBeInstanceOf(SessionFencedError);

      const moving = yield* Session.make({
        transcript: {
          ...recordingTranscript().transcript,
          select: () => {
            throw defect;
          },
        },
      });
      const moved = yield* Effect.exit(moving.moveTo(undefined));
      expect(Exit.isFailure(moved) && Cause.squash(moved.cause)).toBe(defect);
      // Fenced, and no longer busy: the move's cleanup ran.
      expect(yield* Effect.flip(moving.run(user("again")))).toBeInstanceOf(SessionFencedError);
    }),
  );

  it.effect("drains a move and a tree read before the Session's dependencies are released", () =>
    Effect.gen(function* () {
      const order: Array<string> = [];
      const entered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const reading = yield* Deferred.make<void>();
      const { transcript, stored } = recordingTranscript();
      const allocation = yield* Scope.make();
      const session = yield* Effect.gen(function* () {
        yield* Effect.acquireRelease(Effect.void, () =>
          Effect.sync(() => void order.push("store released")),
        );
        return yield* Session.make({
          transcript: {
            ...transcript,
            select: (position, expected) =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(gate)),
                Effect.andThen(transcript.select(position, expected)),
                Effect.ensuring(Effect.sync(() => void order.push("select settled"))),
              ),
            tree: Deferred.succeed(reading, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Effect.sync(() => void order.push("tree interrupted"))),
            ),
          },
        });
      }).pipe(Effect.provideService(Scope.Scope, allocation));
      yield* session.run(user("one"));
      const read = yield* Effect.forkChild(session.tree);
      yield* Deferred.await(reading);
      const move = yield* Effect.forkChild(session.moveTo(undefined));
      yield* Deferred.await(entered);
      const close = yield* Effect.forkChild(Scope.close(allocation, Exit.void), {
        startImmediately: true,
      });
      yield* settle;

      expect(close.pollUnsafe()).toBeUndefined();
      expect(order).toEqual([]);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(close);

      // Newest first: the started move completes, the read is interrupted, then the store goes.
      expect(order).toEqual(["select settled", "tree interrupted", "store released"]);
      // The move completed, though its caller sees the release that interrupted it.
      expect(stored.position).toBeUndefined();
      expect(Exit.hasInterrupts(yield* Fiber.await(move))).toBe(true);
      expect(Exit.hasInterrupts(yield* Fiber.await(read))).toBe(true);
    }),
  );

  it.effect("commits no Entry for a complete Step with nothing to commit", () =>
    Effect.gen(function* () {
      const { transcript, stored } = recordingTranscript();
      const session = yield* Session.make({ transcript });
      yield* session.run(user("one"));
      const before = yield* session.position;
      const result = yield* session.run(
        step().pipe(Effect.provide(scriptedModel([[finish("stop")]], []))),
      );

      expect(result._tag).toBe("Complete");
      expect((yield* session.turns)[1]?.entries).toEqual([]);
      expect(yield* session.position).toBe(before);
      expect(stored.entries.size).toBe(1);
      expect(stored.position).toBe(before);
    }),
  );

  it.effect("reads the Transcript's tree each time it is asked", () =>
    Effect.gen(function* () {
      const { transcript, stored } = recordingTranscript();
      // An adapter may compute its tree on each read, here through a getter.
      const live: Session.Transcript = {
        id: transcript.id,
        open: transcript.open,
        append: transcript.append,
        select: transcript.select,
        get tree() {
          return Effect.succeed(
            Array.from(stored.entries.values(), ({ id, parent }) => ({ id, parent })),
          );
        },
      };
      const session = yield* Session.make({ transcript: live });
      expect(yield* session.tree).toEqual([]);
      yield* session.run(user("one"));
      expect(yield* session.tree).toEqual([{ id: yield* session.position, parent: undefined }]);
    }),
  );
});
