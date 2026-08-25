import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { configDirectory, configDirectoryMessage } from "./config.js";
import { TranscriptSchema } from "./transcript.js";
import type { TranscriptId } from "./transcript.js";
import {
  StoreError,
  summarizeTranscript,
  TranscriptEventRecordSchema,
  TranscriptNotFound,
} from "./transcript-store.js";
import type { TranscriptStore, TranscriptSummary } from "./transcript-store.js";

const StoredTranscriptFileVersion = 1 as const;
const StoredTranscriptFileSchema = Schema.Struct({
  fileVersion: Schema.Literal(StoredTranscriptFileVersion),
  transcript: TranscriptSchema,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
type StoredTranscriptFile = typeof StoredTranscriptFileSchema.Type;

const transcriptSuffix = ".transcript.json";
const eventsSuffix = ".events.jsonl";
const temporaryPrefix = ".transcript-";

const encodeId = (id: TranscriptId): string => Buffer.from(id, "utf16le").toString("base64url");

const fileName = (id: TranscriptId, suffix: string): string => `${encodeId(id)}${suffix}`;

const storeError = (message: string, cause?: unknown): StoreError =>
  new StoreError({ message, cause });

const attempt = <A>(
  operation: string,
  path: string,
  run: () => Promise<A>,
): Effect.Effect<A, StoreError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => storeError(`Transcript store could not ${operation} ${path}.`, cause),
  });

const ensureDirectory = (directory: string): Effect.Effect<void, StoreError> =>
  attempt("create directory", directory, () => mkdir(directory, { recursive: true, mode: 0o700 }));

const decodeStoredTranscript = (
  path: string,
  contents: string,
): Effect.Effect<StoredTranscriptFile, StoreError> =>
  Effect.try({
    try: () =>
      Schema.decodeUnknownSync(StoredTranscriptFileSchema, { onExcessProperty: "error" })(
        JSON.parse(contents),
      ),
    catch: (cause) => storeError(`Invalid Transcript store file: ${path}.`, cause),
  });

const idFromFileName = (
  name: string,
  suffix: string,
  path: string,
): Effect.Effect<TranscriptId, StoreError> =>
  Effect.try({
    try: () => {
      const id = Buffer.from(name.slice(0, -suffix.length), "base64url").toString("utf16le");
      if (fileName(id, suffix) !== name) throw new Error("Non-canonical file name");
      return id;
    },
    catch: (cause) => storeError(`Invalid Transcript store file name: ${path}.`, cause),
  });

const readStoredTranscript = (
  directory: string,
  id: TranscriptId,
): Effect.Effect<StoredTranscriptFile, StoreError | TranscriptNotFound> => {
  const path = join(directory, fileName(id, transcriptSuffix));
  return Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) => {
      // SAFETY: Node filesystem promises reject with errno-bearing Error objects.
      const error = cause as NodeJS.ErrnoException;
      return error.code === "ENOENT"
        ? new TranscriptNotFound({ id })
        : storeError(`Transcript store could not read ${path}.`, cause);
    },
  }).pipe(Effect.flatMap((contents) => decodeStoredTranscript(path, contents)));
};

const readStoredTranscriptIfPresent = (
  directory: string,
  id: TranscriptId,
): Effect.Effect<StoredTranscriptFile | undefined, StoreError> =>
  Effect.catchTag(readStoredTranscript(directory, id), "TranscriptNotFound", () =>
    Effect.succeed(undefined),
  );

const validateTranscriptId = (
  path: string,
  expected: TranscriptId,
  actual: TranscriptId,
): Effect.Effect<void, StoreError> =>
  expected === actual
    ? Effect.void
    : Effect.fail(storeError(`Transcript id in ${path} does not match its file name.`));

const defaultTranscriptDirectory = (): string => {
  const home = configDirectory();
  if (home === undefined) {
    throw new Error(`Cannot configure file Transcript persistence. ${configDirectoryMessage}`);
  }
  return join(home, "transcripts");
};

/** Creates a disk-backed store rooted at `directory` or the Mitome config directory. */
export const fileTranscripts = (
  directory: string = defaultTranscriptDirectory(),
): TranscriptStore => ({
  save: (transcript) =>
    Effect.gen(function* () {
      yield* ensureDirectory(directory);
      const path = join(directory, fileName(transcript.id, transcriptSuffix));
      const previous = yield* readStoredTranscriptIfPresent(directory, transcript.id);
      if (previous !== undefined) {
        yield* validateTranscriptId(path, transcript.id, previous.transcript.id);
      }
      const now = new Date().toISOString();
      const stored: StoredTranscriptFile = {
        fileVersion: StoredTranscriptFileVersion,
        transcript,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
      const encoded = Schema.encodeUnknownSync(StoredTranscriptFileSchema)(stored);
      const temporary = join(directory, `${temporaryPrefix}${process.pid}-${crypto.randomUUID()}`);
      yield* attempt("write", temporary, () =>
        writeFile(temporary, `${JSON.stringify(encoded)}\n`, { flag: "wx", mode: 0o600 }),
      );
      yield* attempt("replace", path, () => rename(temporary, path)).pipe(
        Effect.ensuring(
          Effect.ignore(
            attempt("remove temporary file", temporary, () => rm(temporary, { force: true })),
          ),
        ),
      );
    }),
  load: (id) =>
    Effect.gen(function* () {
      const path = join(directory, fileName(id, transcriptSuffix));
      const stored = yield* readStoredTranscript(directory, id);
      yield* validateTranscriptId(path, id, stored.transcript.id);
      return stored.transcript;
    }),
  list: () =>
    Effect.gen(function* () {
      yield* ensureDirectory(directory);
      const entries = yield* attempt("list directory", directory, () =>
        readdir(directory, { withFileTypes: true }),
      );
      const summaries: Array<TranscriptSummary> = [];
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (!entry.isFile() || entry.name.startsWith(temporaryPrefix)) continue;
        if (entry.name.endsWith(transcriptSuffix)) {
          const id = yield* idFromFileName(entry.name, transcriptSuffix, path);
          const stored = yield* decodeStoredTranscript(
            path,
            yield* attempt("read", path, () => readFile(path, "utf8")),
          );
          yield* validateTranscriptId(path, id, stored.transcript.id);
          summaries.push({
            id,
            parentTranscriptId: stored.transcript.parentTranscriptId,
            createdAt: stored.createdAt,
            updatedAt: stored.updatedAt,
            ...summarizeTranscript(stored.transcript),
          });
          continue;
        }
        if (entry.name.endsWith(eventsSuffix)) continue;
      }
      return summaries.sort((left, right) => left.id.localeCompare(right.id));
    }),
  appendEvent: (record) =>
    Effect.gen(function* () {
      yield* ensureDirectory(directory);
      const path = join(directory, fileName(record.transcriptId, eventsSuffix));
      const encoded = Schema.encodeUnknownSync(TranscriptEventRecordSchema)(record);
      yield* attempt("append", path, () =>
        appendFile(path, `${JSON.stringify(encoded)}\n`, { encoding: "utf8", mode: 0o600 }),
      );
    }),
});
