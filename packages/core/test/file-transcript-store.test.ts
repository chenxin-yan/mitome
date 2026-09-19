import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

  // Root ignores directory permissions, so the write would succeed.
  it.effect.skipIf(process.getuid?.() === 0)(
    "keeps the stored Transcript when the temporary file cannot be created",
    () =>
      withDirectory((directory) =>
        Effect.gen(function* () {
          const store = fileTranscripts(directory);
          const transcript = makeTranscript({ id: "transcript-1", messages: [] });
          yield* store.save(transcript);

          yield* Effect.promise(() => chmod(directory, 0o500));
          const failure = yield* Effect.flip(
            store.save(
              makeTranscript({ id: transcript.id, messages: [], parentTranscriptId: "p" }),
            ),
          ).pipe(Effect.ensuring(Effect.promise(() => chmod(directory, 0o700))));
          expect(failure).toBeInstanceOf(StoreError);
          expect(failure.message).toContain("could not write");

          expect(yield* Effect.promise(() => readdir(directory))).toEqual([
            expect.stringMatching(/\.transcript\.json$/),
          ]);
          expect(yield* store.load(transcript.id)).toEqual(transcript);
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
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        yield* first.save(transcript);

        const second = fileTranscripts(directory);
        vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
        yield* second.save(transcript);
        const [after] = yield* second.list();

        expect(after).toMatchObject({
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
        });
      }).pipe(Effect.ensuring(Effect.sync(() => vi.useRealTimers()))),
    ),
  );

  it.effect("reports corrupt Transcript files and ignores foreign entries", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writeFile(join(directory, "broken.transcript.json"), "{"));
        const store = fileTranscripts(directory);
        const invalidName = yield* Effect.flip(store.list());
        expect(invalidName).toBeInstanceOf(StoreError);
        expect(invalidName.message).toBe(
          `Invalid Transcript store file name: ${join(directory, "broken.transcript.json")}.`,
        );
        yield* Effect.promise(() => rm(join(directory, "broken.transcript.json")));

        yield* store.save(makeTranscript({ id: "broken", messages: [] }));
        const [name] = yield* Effect.promise(() => readdir(directory));
        const path = join(directory, name!);
        yield* Effect.promise(() => writeFile(path, "{"));
        const corrupt = yield* Effect.flip(store.list());
        expect(corrupt).toBeInstanceOf(StoreError);
        expect(corrupt.message).toBe(`Invalid Transcript store file: ${path}.`);

        yield* Effect.promise(() => rm(path));
        yield* Effect.promise(() => writeFile(join(directory, "foreign.txt"), "not mitome"));
        expect(yield* store.list()).toEqual([]);
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
