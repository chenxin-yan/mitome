import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "@effect/vitest";
import { Effect } from "effect";
import { Prompt } from "effect/unstable/ai";
import {
  fileTranscripts,
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

describe("fileTranscripts", () => {
  it("fails loudly without an explicit directory or resolvable config directory", () => {
    for (const name of ["MITOME_HOME", "XDG_CONFIG_HOME", "APPDATA", "HOME"]) {
      vi.stubEnv(name, "");
    }
    try {
      expect(() => fileTranscripts()).toThrow(
        "Set MITOME_HOME, XDG_CONFIG_HOME, APPDATA (on Windows), or HOME.",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.effect("reloads Transcripts and event logs from the filesystem", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        const writer = fileTranscripts(directory);
        const transcript = makeTranscript({
          id: "transcript-1",
          messages: Prompt.make([
            Prompt.makeMessage("user", { content: [Prompt.textPart({ text: "hello" })] }),
          ]).content,
        });
        yield* writer.appendEvent({
          transcriptId: transcript.id,
          sessionId: "session-1",
          seq: 0,
          version: TranscriptEventRecordVersion,
          event: { type: "model-output", text: "hello" },
        });
        yield* writer.save(transcript);

        const reader = fileTranscripts(directory);
        expect(yield* reader.load(transcript.id)).toEqual(transcript);
        expect(yield* reader.list()).toEqual([
          {
            id: transcript.id,
            createdAt: expect.any(String),
            updatedAt: expect.any(String),
            messageCount: 1,
            preview: "hello",
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

  it.effect("ignores an event log record truncated by process death", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        const store = fileTranscripts(directory);
        const transcript = makeTranscript({ id: "transcript-1", messages: [] });
        yield* store.save(transcript);
        yield* store.appendEvent({
          transcriptId: transcript.id,
          sessionId: "session-1",
          seq: 0,
          version: TranscriptEventRecordVersion,
          event: { type: "model-output", text: "hello" },
        });
        const eventFile = (yield* Effect.promise(() => readdir(directory))).find((name) =>
          name.endsWith(".events.jsonl"),
        );
        yield* Effect.promise(() =>
          writeFile(join(directory, eventFile!), '{"truncated"', { flag: "a" }),
        );

        expect(yield* store.list()).toHaveLength(1);
      }),
    ),
  );

  it.effect("ignores an atomic-save temporary file", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        const store = fileTranscripts(directory);
        yield* store.save(makeTranscript({ id: "transcript-1", messages: [] }));
        yield* Effect.promise(() =>
          writeFile(join(directory, ".transcript-123-leftover"), "partial"),
        );

        expect(yield* store.list()).toHaveLength(1);
      }),
    ),
  );

  it.effect("lists Transcript ids that share the temporary-file prefix", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        const store = fileTranscripts(directory);
        const transcript = makeTranscript({ id: ".transcript-valid", messages: [] });
        yield* store.save(transcript);
        yield* store.appendEvent({
          transcriptId: transcript.id,
          sessionId: "session-1",
          seq: 0,
          version: TranscriptEventRecordVersion,
          event: { type: "model-output", text: "hello" },
        });

        expect(yield* store.list()).toEqual([expect.objectContaining({ id: transcript.id })]);
      }),
    ),
  );

  it.effect("round-trips unpaired-surrogate ids without filename collisions", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        const store = fileTranscripts(directory);
        const ids = ["\ud800", "�"];
        for (const id of ids) {
          const transcript = makeTranscript({ id, messages: [] });
          yield* store.save(transcript);
          yield* store.appendEvent({
            transcriptId: id,
            sessionId: "session-1",
            seq: 0,
            version: TranscriptEventRecordVersion,
            event: { type: "model-output", text: "hello" },
          });
          expect(yield* store.load(id)).toEqual(transcript);
        }

        expect((yield* store.list()).map(({ id }) => id)).toEqual(ids);
      }),
    ),
  );

  it.effect("retains creation metadata when a later adapter replaces a Transcript", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        const transcript = makeTranscript({ id: "transcript-1", messages: [] });
        const first = fileTranscripts(directory);
        yield* first.save(transcript);
        const [before] = yield* first.list();

        const second = fileTranscripts(directory);
        yield* second.save(transcript);
        const [after] = yield* second.list();

        expect(after!.createdAt).toBe(before!.createdAt);
      }),
    ),
  );

  it.effect("reports corrupt Transcript files and ignores foreign entries", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writeFile(join(directory, "broken.transcript.json"), "{"));
        const corrupt = yield* Effect.flip(fileTranscripts(directory).list());
        expect(corrupt).toBeInstanceOf(StoreError);
        expect(corrupt.message).toContain("broken.transcript.json");

        yield* Effect.promise(() => rm(join(directory, "broken.transcript.json")));
        yield* Effect.promise(() => writeFile(join(directory, "foreign.txt"), "not mitome"));
        expect(yield* fileTranscripts(directory).list()).toEqual([]);
      }),
    ),
  );

  it.effect("does not read write-only event logs when listing Transcripts", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeFile(join(directory, "transcript-1.events.jsonl"), "{}\n"),
        );

        expect(yield* fileTranscripts(directory).list()).toEqual([]);
      }),
    ),
  );
});
