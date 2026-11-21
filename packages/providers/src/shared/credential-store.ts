import {
  Effect,
  Exit,
  FileSystem,
  Path,
  PlatformError,
  Predicate,
  Result,
  Schedule,
  Schema,
  Scope,
} from "effect";

const StoredCredential = Schema.Json;
type StoredCredential = typeof StoredCredential.Type;
const AuthFile = Schema.fromJsonString(Schema.Record(Schema.String, StoredCredential));
type AuthFile = typeof AuthFile.Type;

export class CredentialStoreError extends Schema.TaggedError<
  CredentialStoreError,
  { readonly brand: unique symbol }
>()("CredentialStoreError", {
  message: Schema.String,
  code: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {}

const authPath = (path: Path.Path, stateDirectory: string) =>
  path.join(stateDirectory, "auth.json");
const lockPath = (path: Path.Path, stateDirectory: string) =>
  path.join(stateDirectory, "auth.lock");
const lockTimeout = 30_000;

/** Fails as a storage error carrying what the operating system reported, as the platform's cause. */
const attempt = <A, R>(
  operation: Effect.Effect<A, PlatformError.PlatformError, R>,
): Effect.Effect<A, CredentialStoreError, R> =>
  Effect.mapError(operation, (error) => {
    const cause = error.cause ?? error;
    // The cause is unknown: building the error from it must never throw, or the failure
    // would become a defect.
    const message = Predicate.hasProperty(cause, "message") ? cause.message : undefined;
    const code = Predicate.hasProperty(cause, "code") ? cause.code : undefined;
    return new CredentialStoreError({
      message: Predicate.isString(message) ? message : "Credential storage failed",
      code: Predicate.isString(code) ? code : undefined,
      cause,
    });
  });

const ensureDirectory = Effect.fnUntraced(function* (
  stateDirectory: string,
): Effect.fn.Return<void, CredentialStoreError, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Made without `recursive`, so that succeeding means this call made it and no other process did.
  const make = Effect.as(fs.makeDirectory(stateDirectory, { mode: 0o700 }), true);
  const created = yield* attempt(
    make.pipe(
      Effect.catchReason("PlatformError", "NotFound", () =>
        Effect.andThen(
          fs.makeDirectory(path.dirname(stateDirectory), { recursive: true, mode: 0o700 }),
          make,
        ),
      ),
      // Already there: `recursive` accepts a directory and still refuses a file.
      Effect.catchReason("PlatformError", "AlreadyExists", () =>
        Effect.as(fs.makeDirectory(stateDirectory, { recursive: true, mode: 0o700 }), false),
      ),
    ),
  );
  // An existing directory keeps its mode: `MITOME_HOME` may name a project directory.
  if (created) yield* attempt(fs.chmod(stateDirectory, 0o700));
});

const acquireLock = (fs: FileSystem.FileSystem, path: string) =>
  attempt(fs.open(path, { flag: "wx", mode: 0o600 })).pipe(
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

const readAuth = Effect.fnUntraced(function* (
  stateDirectory: string,
): Effect.fn.Return<AuthFile, CredentialStoreError, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = authPath(yield* Path.Path, stateDirectory);
  const result = yield* Effect.result(attempt(fs.readFileString(path)));
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
  return yield* Schema.decodeEffect(AuthFile)(result.success).pipe(
    Effect.mapError(() => corrupted),
  );
});

const writeAuth = Effect.fnUntraced(function* (
  stateDirectory: string,
  auth: AuthFile,
): Effect.fn.Return<void, CredentialStoreError, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = authPath(yield* Path.Path, stateDirectory);
  const temporary = (yield* Path.Path).join(
    stateDirectory,
    `.auth-${process.pid}-${crypto.randomUUID()}`,
  );
  // Removal covers the write, sync and close too: a failure there must not strand a plaintext copy.
  yield* Effect.gen(function* () {
    const write = Effect.gen(function* () {
      const handle = yield* attempt(fs.open(temporary, { flag: "wx", mode: 0o600 }));
      yield* attempt(handle.writeAll(new TextEncoder().encode(`${JSON.stringify(auth)}\n`)));
      yield* attempt(handle.sync);
    });
    yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const staged = yield* Scope.make();
        const written = yield* Effect.exit(restore(Scope.provide(write, staged)));
        // The platform closes a file as a defect; here a failure to close is a storage failure
        // like any other, and must stop the rename.
        const closed = yield* Effect.exit(
          attempt(
            Effect.catchDefect(Scope.close(staged, Exit.void), (defect) =>
              PlatformError.isPlatformError(defect) ? Effect.fail(defect) : Effect.die(defect),
            ),
          ),
        );
        yield* written;
        yield* closed;
      }),
    );
    yield* attempt(fs.rename(temporary, path));
    yield* attempt(fs.chmod(path, 0o600));
  }).pipe(Effect.ensuring(Effect.ignore(attempt(fs.remove(temporary, { force: true })))));
});

/** Reads one Provider's stored Credential, unvalidated; `undefined` before login. */
export const readCredential = (
  stateDirectory: string,
  providerKey: string,
): Effect.Effect<
  StoredCredential | undefined,
  CredentialStoreError,
  FileSystem.FileSystem | Path.Path
> => Effect.map(readAuth(stateDirectory), (auth) => auth[providerKey]);

/**
 * Runs `update` as a locked transaction over one Provider's entry, so a token
 * exchange can happen inside the lock without racing another process. Only this
 * Provider's entry is visible and replaceable; every other entry is preserved.
 * A replacement of `undefined` removes the entry.
 */
export const modifyCredential = Effect.fnUntraced(function* <A, E, R>(
  stateDirectory: string,
  providerKey: string,
  update: (
    current: StoredCredential | undefined,
  ) => Effect.Effect<readonly [StoredCredential | undefined, A], E, R>,
): Effect.fn.Return<A, CredentialStoreError | E, R | FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = lockPath(yield* Path.Path, stateDirectory);
  yield* ensureDirectory(stateDirectory);
  // The lock's own Scope, closed below, so its handle is closed after the unlink.
  const lock = yield* Scope.make();
  return yield* Effect.acquireUseRelease(
    Scope.provide(acquireLock(fs, path), lock),
    () =>
      Effect.gen(function* () {
        const auth = yield* readAuth(stateDirectory);
        const [next, value] = yield* update(auth[providerKey]);
        if (next === undefined) {
          const { [providerKey]: _, ...remaining } = auth;
          yield* writeAuth(stateDirectory, remaining);
        } else {
          yield* writeAuth(stateDirectory, { ...auth, [providerKey]: next });
        }
        return value;
      }),
    () =>
      Effect.gen(function* () {
        // Unlink before close so a close failure cannot leave the lock behind.
        // Cleanup failures are ignored so they never replace the transaction's cause.
        yield* Effect.ignore(attempt(fs.remove(path)));
        yield* Effect.ignoreCause(Scope.close(lock, Exit.void));
      }),
  );
});
