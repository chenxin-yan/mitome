import { Effect } from "effect";
import { SessionSaveError, TranscriptError } from "../../src/index.js";
import type { Session } from "../../src/kernel.js";

/** What a recording Transcript has stored: its Entries by id and its position. */
interface StoredTranscript {
  readonly entries: Map<string, Session.Entry>;
  position: string | undefined;
}

/**
 * A Transcript over a plain record, so tests can share it between Sessions, read what it stored
 * and run `before` ahead of each append (after its position check) to inject a failure.
 */
export const recordingTranscript = (
  before: (entry: Session.Entry) => Effect.Effect<void, SessionSaveError> = () => Effect.void,
) => {
  const stored: StoredTranscript = { entries: new Map(), position: undefined };
  const branch = (position: string | undefined) => {
    const entries: Array<Session.Entry> = [];
    for (let id = position; id !== undefined;) {
      const entry = stored.entries.get(id);
      if (entry === undefined) break;
      entries.unshift(entry);
      id = entry.parent;
    }
    return entries;
  };
  const conflict = Effect.suspend(() => Effect.fail(new SessionSaveError({ outcome: "conflict" })));
  const transcript: Session.Transcript = {
    id: crypto.randomUUID(),
    open: Effect.sync(() => ({ position: stored.position, branch: branch(stored.position) })),
    append: (entry, expected) =>
      Effect.suspend(() =>
        stored.position !== expected
          ? conflict
          : Effect.andThen(
              before(entry),
              Effect.sync(() => {
                stored.entries.set(entry.id, entry);
                stored.position = entry.id;
              }),
            ),
      ),
    select: (position, expected) =>
      Effect.suspend(
        (): Effect.Effect<Array<Session.Entry>, SessionSaveError | TranscriptError> => {
          if (stored.position !== expected) return conflict;
          if (position !== undefined && !stored.entries.has(position)) {
            return Effect.fail(new TranscriptError({ detail: `no Entry "${position}"` }));
          }
          stored.position = position;
          return Effect.succeed(branch(position));
        },
      ),
    tree: Effect.sync(() =>
      Array.from(stored.entries.values(), ({ id, parent }) => ({ id, parent })),
    ),
  };
  return { transcript, stored };
};
