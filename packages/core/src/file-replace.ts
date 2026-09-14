import { rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import type { StoreError } from "./transcript-store.js";

/** Wraps one filesystem call in the owning store's diagnostics. */
export type Attempt = <A>(
  operation: string,
  path: string,
  run: () => Promise<A>,
) => Effect.Effect<A, StoreError>;

/**
 * Replaces `path` atomically: write a private temporary file beside it, then rename over
 * it. The temporary file is removed on any failure, including a write that fails after
 * creating the file (ENOSPC), so a half-written entry never appears on disk.
 */
export const replaceFile = (
  attempt: Attempt,
  path: string,
  temporaryPrefix: string,
  contents: string,
): Effect.Effect<void, StoreError> => {
  const temporary = join(dirname(path), `${temporaryPrefix}${process.pid}-${crypto.randomUUID()}`);
  return attempt("write", temporary, () =>
    writeFile(temporary, contents, { flag: "wx", mode: 0o600 }),
  ).pipe(
    Effect.andThen(attempt("replace", path, () => rename(temporary, path))),
    Effect.ensuring(
      Effect.ignore(
        attempt("remove temporary file", temporary, () => rm(temporary, { force: true })),
      ),
    ),
  );
};
