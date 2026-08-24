import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  makeFileTranscriptStore,
  makeTranscript,
  StoreError,
  TranscriptEventRecordVersion,
} from "../src/index.js";

const withDirectory = <A, E>(
  use: (directory: string) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "mitome-transcripts-"))),
    use,
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  );

describe("makeFileTranscriptStore", () => {
  it.effect("reloads Transcripts and event logs from the filesystem", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        const writer = makeFileTranscriptStore(directory);
        const transcript = makeTranscript({ id: "transcript-1", messages: [] });
        yield* writer.appendEvent({
          transcriptId: transcript.id,
          sessionId: "session-1",
          seq: 0,
          version: TranscriptEventRecordVersion,
          event: { type: "model-output", text: "hello" },
        });
        yield* writer.save(transcript);

        const reader = makeFileTranscriptStore(directory);
        expect(yield* reader.load(transcript.id)).toEqual(transcript);
        expect(yield* reader.list()).toEqual([
          {
            id: transcript.id,
            createdAt: expect.any(String),
            updatedAt: expect.any(String),
            messageCount: 0,
          },
        ]);

        const eventFile = (yield* Effect.promise(() => readdir(directory))).find((name) =>
          name.endsWith(".events.jsonl"),
        );
        expect(eventFile).toBeDefined();
        expect(
          JSON.parse(
            (yield* Effect.promise(() => readFile(join(directory, eventFile!), "utf8"))).trim(),
          ),
        ).toMatchObject({
          transcriptId: transcript.id,
          sessionId: "session-1",
          seq: 0,
          event: { type: "model-output", text: "hello" },
        });
      }),
    ),
  );

  it.effect("retains creation metadata when a later adapter replaces a Transcript", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        const transcript = makeTranscript({ id: "transcript-1", messages: [] });
        const first = makeFileTranscriptStore(directory);
        yield* first.save(transcript);
        const [before] = yield* first.list();

        const second = makeFileTranscriptStore(directory);
        yield* second.save(transcript);
        const [after] = yield* second.list();

        expect(after!.createdAt).toBe(before!.createdAt);
      }),
    ),
  );

  it.effect("reports corrupt and foreign files as tagged StoreErrors", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writeFile(join(directory, "broken.transcript.json"), "{"));
        const corrupt = yield* Effect.flip(makeFileTranscriptStore(directory).list());
        expect(corrupt).toBeInstanceOf(StoreError);
        expect(corrupt.message).toContain("broken.transcript.json");

        yield* Effect.promise(() => rm(join(directory, "broken.transcript.json")));
        yield* Effect.promise(() => writeFile(join(directory, "foreign.txt"), "not mitome"));
        const foreign = yield* Effect.flip(makeFileTranscriptStore(directory).list());
        expect(foreign).toBeInstanceOf(StoreError);
        expect(foreign.message).toContain("foreign.txt");
      }),
    ),
  );

  it.effect("reports corrupt event records as tagged StoreErrors", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeFile(join(directory, "transcript-1.events.jsonl"), "{}\n"),
        );
        const error = yield* Effect.flip(makeFileTranscriptStore(directory).list());

        expect(error).toBeInstanceOf(StoreError);
        expect(error.message).toContain("transcript-1.events.jsonl");
      }),
    ),
  );
});
