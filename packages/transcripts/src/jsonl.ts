/**
 * Keeps conversations in append-only files: `jsonlTranscripts()` provides `Transcripts` to a
 * Configuration, in its `provide`.
 *
 * @module @mitome/transcripts/jsonl
 */
import {
  isPlainData,
  SessionSaveError,
  stateDirectory,
  stateDirectoryMessage,
  TranscriptError,
  Transcripts,
} from "@mitome/core";
import type { Session, TranscriptsService } from "@mitome/core";
import { Clock, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import type { PlatformError } from "effect";
import { Prompt } from "effect/ai";
import { platformLayer } from "./platform.js";

const Header = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  scope: Schema.String,
  created: Schema.String,
});
const Versioned = Schema.fromJsonString(Schema.Struct({ version: Schema.Unknown }));
const HeaderLine = Schema.fromJsonString(Header);
/** Just what `latest` needs of a header; the rest is checked when the conversation is opened. */
const Scoped = Schema.fromJsonString(Schema.Struct({ scope: Schema.String }));
const Record = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("entry"),
    id: Schema.String,
    parent: Schema.NullOr(Schema.String),
    messages: Schema.Array(Prompt.Message),
  }),
  Schema.Struct({ type: Schema.Literal("position"), position: Schema.NullOr(Schema.String) }),
]);
const Line = Schema.fromJsonString(Record);

/** The ids `create` hands out; `open` treats any other text as no conversation. */
const conversationId = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;
const newline = 0x0a;
/** How long an append waits for another writer's lock before it gives up, writing nothing. */
const lockTimeout = 5000;

/** Nothing was stored, and why. */
const notWritten = (cause: unknown) => new SessionSaveError({ outcome: "not-written", cause });

/** What a conversation's file holds, read up to its last complete line. */
interface Stored {
  readonly header: typeof Header.Type | undefined;
  /** Every Entry by id, in the order the file holds them, each after its parent. */
  readonly entries: Map<string, Session.Entry>;
  readonly position: string | undefined;
  /** The bytes of the complete lines; any after them are an incomplete last line. */
  readonly length: number;
  /** Whether the file ends in an incomplete last line. */
  readonly torn: boolean;
}

const branch = (stored: Stored) => {
  const found: Array<Session.Entry> = [];
  for (let id = stored.position; id !== undefined; id = stored.entries.get(id)?.parent) {
    const entry = stored.entries.get(id);
    if (entry !== undefined) {
      found.unshift(entry);
    }
  }
  return found;
};

const encodeLine = Schema.encodeEffect(Line);
const decodeLine = Schema.decodeEffect(Line);

const unreadable = (where: string, cause: PlatformError.PlatformError) =>
  new TranscriptError({ detail: `${where} cannot be read: ${cause.message}` });

const malformed = (location: string, line: number) =>
  new TranscriptError({ detail: `${location}: line ${line} is malformed` });

/**
 * The conversations under `directory`, one `<id>.jsonl` file each, reached through the platform
 * services `fs` and `path`.
 */
const store = (directory: string, fs: FileSystem.FileSystem, path: Path.Path) => {
  const file = (id: string) => path.join(directory, `${id}.jsonl`);

  /**
   * The complete lines of a conversation's file; `undefined` when there is none. A line is
   * complete once its newline is written: the bytes after the last newline are an incomplete last
   * line (a crash during an append), which is ignored and overwritten by the next append.
   */
  const lines = Effect.fnUntraced(function* (id: string) {
    const location = file(id);
    const bytes = yield* fs.readFile(location).pipe(
      Effect.map(Option.some),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
      Effect.mapError((cause) => unreadable(location, cause)),
    );
    if (Option.isNone(bytes)) {
      return undefined;
    }
    const length = bytes.value.lastIndexOf(newline) + 1;
    const text = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes.value.subarray(0, length)),
      catch: () => new TranscriptError({ detail: `${location} is not UTF-8` }),
    });
    const torn = length < bytes.value.length;
    return { location, lines: text.split("\n").slice(0, -1), length, torn };
  });

  /** Decodes a header line; a version other than 1 fails, as does a header naming another id. */
  const header = Effect.fnUntraced(function* (location: string, id: string, line: string) {
    const { version } = yield* Schema.decodeEffect(Versioned)(line).pipe(
      Effect.mapError(() => malformed(location, 1)),
    );
    if (version !== 1) {
      return yield* new TranscriptError({
        detail: `${location} has version ${JSON.stringify(version)}, which this @mitome/transcripts cannot read`,
      });
    }
    return yield* Schema.decodeEffect(HeaderLine)(line).pipe(
      Effect.filterOrFail((decoded) => decoded.id === id),
      Effect.mapError(() => malformed(location, 1)),
    );
  });

  /**
   * Reads a conversation's file; `undefined` when there is none. A complete line that does not
   * decode, an Entry whose id repeats or whose parent does not come before it, and a position
   * naming no Entry, fail.
   */
  const read = Effect.fnUntraced(function* (id: string) {
    const found = yield* lines(id);
    if (found === undefined) {
      return undefined;
    }
    const { location, length, torn } = found;
    const [first, ...rest] = found.lines;
    const entries = new Map<string, Session.Entry>();
    if (first === undefined) {
      const empty: Stored = { header: undefined, entries, position: undefined, length, torn };
      return empty;
    }
    const decodedHeader = yield* header(location, id, first);
    let position: string | undefined;
    for (const [index, line] of rest.entries()) {
      const decoded = yield* decodeLine(line).pipe(
        Effect.mapError(() => malformed(location, index + 2)),
      );
      if (decoded.type === "position") {
        position = decoded.position ?? undefined;
        if (position !== undefined && !entries.has(position)) {
          return yield* malformed(location, index + 2);
        }
        continue;
      }
      const parent = decoded.parent ?? undefined;
      if (entries.has(decoded.id) || (parent !== undefined && !entries.has(parent))) {
        return yield* malformed(location, index + 2);
      }
      entries.set(decoded.id, { id: decoded.id, parent, messages: decoded.messages });
      position = decoded.id;
    }
    const stored: Stored = { header: decodedHeader, entries, position, length, torn };
    return stored;
  });

  /**
   * The first complete line of a conversation's file, read without the rest; `undefined` until a
   * complete header is written.
   */
  const firstLine = (id: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const location = file(id);
        const handle = yield* fs.open(location, { flag: "r" }).pipe(
          Effect.map(Option.some),
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
          Effect.mapError((cause) => unreadable(location, cause)),
        );
        if (Option.isNone(handle)) {
          return undefined;
        }
        // Each chunk is searched and decoded once, so a long line costs its length. Not fatal:
        // opening the conversation decodes every line strictly.
        const decoder = new TextDecoder();
        let line = "";
        for (;;) {
          const chunk = yield* handle.value
            .readAlloc(4096)
            .pipe(Effect.mapError((cause) => unreadable(location, cause)));
          if (Option.isNone(chunk)) {
            return undefined;
          }
          const end = chunk.value.indexOf(newline);
          if (end === -1) {
            line += decoder.decode(chunk.value, { stream: true });
            continue;
          }
          line += decoder.decode(chunk.value.subarray(0, end));
          return { location, line };
        }
      }),
    );

  /**
   * Creates `target` and any missing directory above it readable by their owner only; an existing
   * one keeps its mode.
   */
  const ensureDirectory = (target: string): Effect.Effect<void, PlatformError.PlatformError> =>
    // Made without `recursive`, so that succeeding means this call made it and no other process did.
    fs.makeDirectory(target, { mode: 0o700 }).pipe(
      Effect.catchReason("PlatformError", "NotFound", () =>
        Effect.andThen(
          ensureDirectory(path.dirname(target)),
          fs.makeDirectory(target, { mode: 0o700 }),
        ),
      ),
      // The umask may have narrowed the mode it was made with, even taking the owner's own access.
      Effect.andThen(fs.chmod(target, 0o700)),
      // Already there: `recursive` accepts a directory and still refuses a file.
      Effect.catchReason("PlatformError", "AlreadyExists", () =>
        fs.makeDirectory(target, { recursive: true, mode: 0o700 }),
      ),
    );

  /**
   * Creates the lock file at `lock`, waiting while another writer holds it. Only the waits are
   * interruptible (through `restore`): an attempt always finishes, so a lock it creates is always
   * returned to be removed.
   */
  const takeLock = (
    lock: string,
    restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
    startedAt: number,
  ): Effect.Effect<void, PlatformError.PlatformError | SessionSaveError> =>
    fs
      .writeFile(lock, new Uint8Array(), { flag: "wx", mode: 0o600 })
      .pipe(
        Effect.catchReason("PlatformError", "AlreadyExists", () =>
          Effect.flatMap(Clock.currentTimeMillis, (now) =>
            now - startedAt >= lockTimeout
              ? Effect.fail(
                  notWritten(
                    new Error(
                      `another writer held the lock ${lock} for ${lockTimeout / 1000} seconds; if no other process is using this conversation, delete that file`,
                    ),
                  ),
                )
              : Effect.andThen(restore(Effect.sleep(10)), takeLock(lock, restore, startedAt)),
          ),
        ),
      );

  /**
   * Under the conversation's lock, reads what it stores and appends what `next` makes of it,
   * synced before it answers. Nothing is written when `next` fails. A failure before the first
   * byte is written is `not-written`; once writing starts, any failure is `unknown`.
   */
  const write = <A, E>(
    id: string,
    scope: string,
    next: (
      stored: Stored | undefined,
    ) => Effect.Effect<{ readonly lines: ReadonlyArray<string>; readonly result: A }, E>,
  ) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const lock = path.join(directory, `${id}.lock`);
        yield* ensureDirectory(directory).pipe(Effect.mapError(notWritten));
        yield* takeLock(lock, restore, yield* Clock.currentTimeMillis).pipe(
          Effect.catchTag("PlatformError", (error) => Effect.fail(notWritten(error))),
        );
        return yield* restore(
          Effect.gen(function* () {
            const stored = yield* read(id).pipe(Effect.mapError(notWritten));
            const { lines, result } = yield* next(stored);
            const header =
              stored?.header === undefined
                ? yield* Schema.encodeEffect(HeaderLine)({
                    version: 1,
                    id,
                    scope,
                    created: new Date(yield* Clock.currentTimeMillis).toISOString(),
                  }).pipe(Effect.mapError(notWritten))
                : undefined;
            const bytes = new TextEncoder().encode(
              [...(header === undefined ? [] : [header]), ...lines]
                .map((line) => `${line}\n`)
                .join(""),
            );
            const location = file(id);
            yield* Effect.scoped(
              Effect.gen(function* () {
                // An incomplete last line is overwritten, so the next line starts clean. Through
                // the path, not the append-only handle, which Windows does not let set a file's end.
                if (stored?.torn === true) {
                  yield* fs.truncate(location, stored.length);
                }
                const handle = yield* fs.open(location, {
                  flag: stored === undefined ? "wx" : "a",
                  mode: 0o600,
                });
                // The umask may have narrowed the mode a new file was created with.
                if (stored?.header === undefined) {
                  yield* fs.chmod(location, 0o600);
                }
                yield* Effect.andThen(handle.writeAll(bytes), handle.sync).pipe(
                  Effect.mapError((cause) => new SessionSaveError({ outcome: "unknown", cause })),
                );
              }),
            ).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(notWritten(error))));
            return result;
          }),
        ).pipe(Effect.ensuring(Effect.ignore(fs.remove(lock))));
      }),
    );

  const transcript = (id: string, scope: string): Session.Transcript => {
    const reading = read(id);
    const conflict = new SessionSaveError({ outcome: "conflict" });
    return {
      id,
      open: Effect.map(reading, (stored) =>
        stored === undefined
          ? { position: undefined, branch: [] }
          : { position: stored.position, branch: branch(stored) },
      ),
      append: (entry, expected) =>
        write(id, scope, (stored) => {
          if (stored?.position !== expected) {
            return Effect.fail(conflict);
          }
          // Refused before the file is touched: the store never acknowledges an Entry that `read`
          // would reject, with a repeated id or a parent it does not hold.
          if (stored?.entries.has(entry.id) === true) {
            return Effect.fail(notWritten(new Error(`Entry "${entry.id}" is already stored`)));
          }
          if (entry.parent !== undefined && stored?.entries.has(entry.parent) !== true) {
            return Effect.fail(
              notWritten(new Error(`the parent Entry "${entry.parent}" is not stored`)),
            );
          }
          // The kernel's rule, applied before printing: only plain data is written, and a field of
          // `undefined` is not plain data. JSON then keeps all of it but the sign of -0, which a
          // Session has already dropped. Plain data the codec cannot decode once printed is refused
          // too.
          return Schema.encodeEffect(Record)({
            type: "entry",
            id: entry.id,
            parent: entry.parent ?? null,
            messages: entry.messages,
          }).pipe(
            Effect.filterOrFail(isPlainData, () => new Error("the Entry is not plain data")),
            Effect.flatMap((encoded) => Effect.try(() => JSON.stringify(encoded))),
            Effect.tap(decodeLine),
            Effect.mapBoth({
              onFailure: notWritten,
              onSuccess: (line) => ({ lines: [line], result: undefined }),
            }),
          );
        }),
      select: (position, expected) =>
        write(
          id,
          scope,
          (
            stored,
          ): Effect.Effect<
            { lines: Array<string>; result: Array<Session.Entry> },
            SessionSaveError | TranscriptError
          > => {
            if (stored?.position !== expected) {
              return Effect.fail(conflict);
            }
            if (position !== undefined && stored?.entries.has(position) !== true) {
              return Effect.fail(new TranscriptError({ detail: `no Entry "${position}"` }));
            }
            return encodeLine({ type: "position", position: position ?? null }).pipe(
              Effect.mapBoth({
                onFailure: notWritten,
                onSuccess: (line) => ({
                  lines: [line],
                  result: stored === undefined ? [] : branch({ ...stored, position }),
                }),
              }),
            );
          },
        ),
      tree: Effect.map(reading, (stored) =>
        Array.from(stored?.entries.values() ?? [], ({ id, parent }) => ({ id, parent })),
      ),
    };
  };

  const service: TranscriptsService = {
    create: (scope) => Effect.sync(() => transcript(crypto.randomUUID(), scope)),
    open: (id) =>
      conversationId.test(id)
        ? Effect.gen(function* () {
            const found = yield* firstLine(id);
            if (found === undefined) {
              return undefined;
            }
            return transcript(id, (yield* header(found.location, id, found.line)).scope);
          })
        : Effect.succeed(undefined),
    // shortcut: each call lists and stats the whole directory, then reads headers newest first
    // until one has `scope`; keep an index of scopes once a directory holds many conversations.
    // A header with no readable scope belongs to no scope, so it never blocks another's.
    latest: (scope) =>
      Effect.gen(function* () {
        const names = yield* fs.readDirectory(directory).pipe(
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])),
          Effect.mapError((cause) => unreadable(directory, cause)),
        );
        const written = yield* Effect.forEach(
          names.flatMap((name) => {
            const id = name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : "";
            return conversationId.test(id) ? [id] : [];
          }),
          (id) =>
            fs.stat(file(id)).pipe(
              Effect.map((info) => ({ id, at: Option.getOrElse(info.mtime, () => new Date(0)) })),
              Effect.mapError((cause) => unreadable(file(id), cause)),
            ),
        );
        written.sort((a, b) => b.at.getTime() - a.at.getTime());
        for (const { id } of written) {
          const found = yield* firstLine(id);
          const named =
            found === undefined ? Option.none() : Schema.decodeOption(Scoped)(found.line);
          if (Option.isSome(named) && named.value.scope === scope) {
            return transcript(id, scope);
          }
        }
        return undefined;
      }),
  };
  return service;
};

/**
 * Keeps each conversation in its own append-only file, `<id>.jsonl`, under `directory`: by default
 * `transcripts` in the state directory, readable by its owner only on POSIX. Provides `Transcripts` and
 * requires nothing; building it fails when no state directory can be resolved and none is given.
 * It applies the kernel's rule (`isPlainData` from `@mitome/core`) to what it is given: an Entry
 * that is not plain data is not written, a record field whose value is `undefined` included. Of
 * plain data, JSON keeps everything but the sign of negative zero, so an Entry given to it directly
 * is read back with negative zero as zero; a Session never hands it one.
 */
export const jsonlTranscripts = (options?: {
  readonly directory?: string;
}): Layer.Layer<never, TranscriptError> =>
  Layer.effect(
    Transcripts,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const state = stateDirectory();
      const directory =
        options?.directory ?? (state === undefined ? undefined : path.join(state, "transcripts"));
      if (directory === undefined) {
        return yield* new TranscriptError({
          detail: `no state directory to keep conversations in. ${stateDirectoryMessage}`,
        });
      }
      return store(directory, yield* FileSystem.FileSystem, path);
    }),
  ).pipe(Layer.provide(platformLayer));
