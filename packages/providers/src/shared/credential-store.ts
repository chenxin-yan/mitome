import {
  Clock,
  Effect,
  Exit,
  FileSystem,
  Path,
  PlatformError,
  Predicate,
  Result,
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

/**
 * Creates the lock file at `path`, waiting while another holder has it. Only the waits between
 * attempts are interruptible (through `restore`): an attempt always finishes, so a lock it creates
 * is always returned to be released.
 */
const acquireLock = (
  fs: FileSystem.FileSystem,
  path: string,
  restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
  startedAt: number,
): Effect.Effect<FileSystem.File, CredentialStoreError, Scope.Scope> =>
  attempt(fs.open(path, { flag: "wx", mode: 0o600 })).pipe(
    Effect.catchIf(
      (error) => error.code === "EEXIST",
      () =>
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          now - startedAt >= lockTimeout
            ? Effect.fail(
                new CredentialStoreError({
                  message: `Credential storage lock timed out: ${path}. If no other process is authenticating, delete ${path} and retry.`,
                }),
              )
            : Effect.andThen(restore(Effect.sleep(10)), acquireLock(fs, path, restore, startedAt)),
        ),
    ),
  );

/**
 * Runs `use` while holding the lock file at `path`, created exclusively, so a token exchange
 * inside it cannot race another process that takes the same lock. Waiting for the lock and `use`
 * stay interruptible.
 */
export const withLock = <A, E, R>(
  path: string,
  use: Effect.Effect<A, E, R>,
): Effect.Effect<A, CredentialStoreError | E, R | FileSystem.FileSystem> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // The lock's own Scope, closed below, so its handle is closed after the unlink.
      const lock = yield* Scope.make();
      const startedAt = yield* Clock.currentTimeMillis;
      yield* Scope.provide(acquireLock(fs, path, restore, startedAt), lock);
      return yield* restore(use).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            // Unlink before close so a close failure cannot leave the lock behind.
            // Cleanup failures are ignored so they never replace the transaction's cause.
            yield* Effect.ignore(attempt(fs.remove(path)));
            yield* Effect.ignoreCause(Scope.close(lock, Exit.void));
          }),
        ),
      );
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

/** Replaces the file at `path` with `contents`, readable by the owner only, through `temporary`. */
export const writePrivateFile = Effect.fnUntraced(function* (
  path: string,
  temporary: string,
  contents: string,
): Effect.fn.Return<void, CredentialStoreError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  // Removal covers the write, sync and close too: a failure there must not strand a plaintext copy.
  yield* Effect.gen(function* () {
    const write = Effect.gen(function* () {
      const handle = yield* attempt(fs.open(temporary, { flag: "wx", mode: 0o600 }));
      // Set after the exclusive create, since the umask may have narrowed the mode it was
      // created with.
      yield* attempt(fs.chmod(temporary, 0o600));
      yield* attempt(handle.writeAll(new TextEncoder().encode(contents)));
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
  }).pipe(Effect.ensuring(Effect.ignore(attempt(fs.remove(temporary, { force: true })))));
});

const writeAuth = Effect.fnUntraced(function* (stateDirectory: string, auth: AuthFile) {
  const path = yield* Path.Path;
  return yield* writePrivateFile(
    authPath(path, stateDirectory),
    path.join(stateDirectory, `.auth-${process.pid}-${crypto.randomUUID()}`),
    `${JSON.stringify(auth)}\n`,
  );
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
 * A replacement of `undefined` removes the entry; returning the current entry itself writes
 * nothing. `update` and the write of its result are uninterruptible, so a token exchange sent
 * from `update` is always written; `update` marks what may be interrupted before it sends one.
 */
export const modifyCredential = Effect.fnUntraced(function* <A, E, R>(
  stateDirectory: string,
  providerKey: string,
  update: (
    current: StoredCredential | undefined,
  ) => Effect.Effect<readonly [StoredCredential | undefined, A], E, R>,
): Effect.fn.Return<A, CredentialStoreError | E, R | FileSystem.FileSystem | Path.Path> {
  yield* ensureDirectory(stateDirectory);
  return yield* withLock(
    lockPath(yield* Path.Path, stateDirectory),
    Effect.gen(function* () {
      const auth = yield* readAuth(stateDirectory);
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const [next, value] = yield* update(auth[providerKey]);
          if (next === auth[providerKey]) return value;
          if (next === undefined) {
            const { [providerKey]: _, ...remaining } = auth;
            yield* writeAuth(stateDirectory, remaining);
          } else {
            yield* writeAuth(stateDirectory, { ...auth, [providerKey]: next });
          }
          return value;
        }),
      );
    }),
  );
});
