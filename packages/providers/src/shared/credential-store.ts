import { chmod, mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Data, Effect, Result, Schedule, Schema } from "effect";

const AuthFile = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
type AuthFile = typeof AuthFile.Type;

export class CredentialStoreError extends Data.TaggedError("CredentialStoreError")<{
  readonly message: string;
  readonly code?: string;
  readonly cause?: unknown;
}> {}

const authPath = (configDirectory: string) => join(configDirectory, "auth.json");
const lockPath = (configDirectory: string) => join(configDirectory, "auth.lock");
const lockTimeout = 30_000;

const attempt = <A>(operation: () => Promise<A>): Effect.Effect<A, CredentialStoreError> =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) => {
      const error = cause as NodeJS.ErrnoException;
      return new CredentialStoreError({
        message: error.message,
        ...(error.code === undefined ? {} : { code: error.code }),
        cause,
      });
    },
  });

const ensureDirectory = (configDirectory: string): Effect.Effect<void, CredentialStoreError> =>
  Effect.gen(function* () {
    yield* attempt(() => mkdir(configDirectory, { recursive: true, mode: 0o700 }));
    yield* attempt(() => chmod(configDirectory, 0o700));
  });

const acquireLock = (configDirectory: string) => {
  const path = lockPath(configDirectory);
  return attempt(() => open(path, "wx", 0o600)).pipe(
    Effect.retry({ while: (error) => error.code === "EEXIST", schedule: Schedule.spaced(10) }),
    // ponytail: a timeout firing mid-open can strand the lock file; the next
    // caller's timeout error names its path, same recovery story as before.
    Effect.timeoutOrElse({
      duration: lockTimeout,
      orElse: () =>
        new CredentialStoreError({
          message: `Credential storage lock timed out: ${path}. If no other process is authenticating, delete ${path} and retry.`,
        }),
    }),
  );
};

const readAuth = (configDirectory: string): Effect.Effect<AuthFile, CredentialStoreError> =>
  Effect.gen(function* () {
    const path = authPath(configDirectory);
    const result = yield* Effect.result(attempt(() => readFile(path, "utf8")));
    if (!Result.isSuccess(result)) {
      // Absent storage is the pre-login state, not a failure.
      if (result.failure.code === "ENOENT") return {};
      return yield* result.failure;
    }
    // Every write reads first, so an unreadable file would otherwise block re-authentication
    // with a bare SyntaxError naming neither the file nor the way out.
    const corrupted = new CredentialStoreError({
      message: `Credential storage at ${path} is corrupted; delete it and authenticate again.`,
    });
    return yield* Schema.decodeUnknownEffect(AuthFile)(result.success).pipe(
      Effect.mapError(() => corrupted),
    );
  });

const writeAuth = (
  configDirectory: string,
  auth: AuthFile,
): Effect.Effect<void, CredentialStoreError> =>
  Effect.gen(function* () {
    const path = authPath(configDirectory);
    const temporary = join(configDirectory, `.auth-${process.pid}-${crypto.randomUUID()}`);
    yield* Effect.acquireUseRelease(
      attempt(() => open(temporary, "wx", 0o600)),
      (handle) =>
        Effect.gen(function* () {
          yield* attempt(() => handle.writeFile(`${JSON.stringify(auth)}\n`));
          yield* attempt(() => handle.sync());
        }),
      (handle) => attempt(() => handle.close()),
    );
    yield* Effect.gen(function* () {
      yield* attempt(() => rename(temporary, path));
      yield* attempt(() => chmod(path, 0o600));
    }).pipe(Effect.ensuring(Effect.ignore(attempt(() => rm(temporary, { force: true })))));
  });

/** Reads one Provider's stored Credential, unvalidated; `undefined` before login. */
export const readCredential = (
  configDirectory: string,
  providerKey: string,
): Effect.Effect<unknown, CredentialStoreError> =>
  Effect.map(readAuth(configDirectory), (auth) => auth[providerKey]);

/**
 * Runs `update` as a locked transaction over one Provider's entry, so a token
 * exchange can happen inside the lock without racing another process. Only this
 * Provider's entry is visible and replaceable; every other entry is preserved.
 * A replacement of `undefined` removes the entry.
 */
export const modifyCredential = <A, E, R>(
  configDirectory: string,
  providerKey: string,
  update: (current: unknown) => Effect.Effect<readonly [unknown, A], E, R>,
): Effect.Effect<A, CredentialStoreError | E, R> =>
  Effect.gen(function* () {
    yield* ensureDirectory(configDirectory);
    return yield* Effect.acquireUseRelease(
      acquireLock(configDirectory),
      () =>
        Effect.gen(function* () {
          const auth = yield* readAuth(configDirectory);
          const [next, value] = yield* update(auth[providerKey]);
          if (next === undefined) {
            const { [providerKey]: _, ...remaining } = auth;
            yield* writeAuth(configDirectory, remaining);
          } else {
            yield* writeAuth(configDirectory, { ...auth, [providerKey]: next });
          }
          return value;
        }),
      (lock) =>
        Effect.gen(function* () {
          // Unlink before close so a close failure cannot leave the lock behind.
          // Cleanup failures are ignored so they never replace the transaction's cause.
          yield* Effect.ignore(attempt(() => unlink(lockPath(configDirectory))));
          yield* Effect.ignore(attempt(() => lock.close()));
        }),
    );
  });
