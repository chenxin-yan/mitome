import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { configDirectory, configDirectoryMessage } from "./config.js";
import { replaceFile } from "./file-replace.js";
import { encodeRouteKey } from "./routes.js";
import type { RouteKey, Routes } from "./routes.js";
import { StoreError } from "./transcript-store.js";

const RouteFileVersion = 1 as const;
const RouteFileSchema = Schema.Struct({
  fileVersion: Schema.Literal(RouteFileVersion),
  channel: Schema.String,
  principal: Schema.String,
  conversation: Schema.String,
  transcriptId: Schema.String,
});
const decodeRouteFile = Schema.decodeEffect(Schema.fromJsonString(RouteFileSchema), {
  onExcessProperty: "error",
});

const routeSuffix = ".route.json";
const temporaryPrefix = ".route-";

const storeError = (message: string, cause?: unknown): StoreError =>
  new StoreError({ message, cause });

const attempt = <A>(
  operation: string,
  path: string,
  run: () => Promise<A>,
): Effect.Effect<A, StoreError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => storeError(`Route store could not ${operation} ${path}.`, cause),
  });

// Keys are hashed because a raw encoding of three surface-chosen ids can exceed the file
// name limit; the key is repeated inside the file so a read can verify it.
const routePath = (directory: string, key: RouteKey): Effect.Effect<string, StoreError> =>
  attempt("hash the key for", directory, async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(encodeRouteKey(key)),
    );
    return join(directory, `${Buffer.from(digest).toString("base64url")}${routeSuffix}`);
  });

const defaultRouteDirectory = (): string => {
  const home = configDirectory();
  if (home === undefined) {
    throw new Error(`Cannot configure file Route persistence. ${configDirectoryMessage}`);
  }
  return join(home, "routes");
};

/**
 * Creates a disk-backed Route store rooted at `directory` or `<config>/routes`, one file per
 * conversation, so Routes survive a restart. Writes are atomic per Route; the two-write ceiling
 * documented on `Routes` still applies between Transcript save and Route advance.
 */
export const fileRoutes = (directory: string = defaultRouteDirectory()): Routes => ({
  get: (key) =>
    Effect.gen(function* () {
      const path = yield* routePath(directory, key);
      const contents = yield* attempt("read", path, async () => {
        try {
          return await readFile(path, "utf8");
        } catch (error) {
          // SAFETY: Node filesystem promises reject with errno-bearing Error objects.
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        }
      });
      if (contents === undefined) return undefined;
      const stored = yield* decodeRouteFile(contents).pipe(
        Effect.mapError((cause) => storeError(`Invalid Route store file: ${path}.`, cause)),
      );
      if (encodeRouteKey(stored) !== encodeRouteKey(key)) {
        return yield* storeError(`Route key in ${path} does not match its file name.`);
      }
      return stored.transcriptId;
    }),
  set: (key, transcriptId) =>
    Effect.gen(function* () {
      yield* attempt("create directory", directory, () =>
        mkdir(directory, { recursive: true, mode: 0o700 }),
      );
      const path = yield* routePath(directory, key);
      const encoded = Schema.encodeUnknownSync(RouteFileSchema)({
        fileVersion: RouteFileVersion,
        ...key,
        transcriptId,
      });
      yield* replaceFile(attempt, path, temporaryPrefix, `${JSON.stringify(encoded)}\n`);
    }),
  clear: (key) =>
    Effect.gen(function* () {
      const path = yield* routePath(directory, key);
      yield* attempt("remove", path, () => rm(path, { force: true }));
    }),
});
