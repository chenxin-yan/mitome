import { chmod, mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

type AuthFile = Record<string, unknown>;

const authPath = (configDirectory: string) => join(configDirectory, "auth.json");
const lockPath = (configDirectory: string) => join(configDirectory, "auth.lock");
const lockTimeout = 30_000;

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

const ensureDirectory = async (configDirectory: string): Promise<void> => {
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await chmod(configDirectory, 0o700);
};

const acquireLock = async (configDirectory: string) => {
  const path = lockPath(configDirectory);
  const deadline = Date.now() + lockTimeout;
  while (Date.now() < deadline) {
    try {
      return await open(path, "wx", 0o600);
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
    }
    await setTimeout(10);
  }
  throw new Error(`Credential storage lock timed out: ${path}`);
};

const readAuth = async (configDirectory: string): Promise<AuthFile> => {
  const path = authPath(configDirectory);
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    // Absent storage is the pre-login state, not a failure.
    if (isMissing(error)) return {};
    throw error;
  }
  // Every write reads first, so an unreadable file would otherwise block re-authentication
  // with a bare SyntaxError naming neither the file nor the way out.
  const corrupted = new Error(
    `Credential storage at ${path} is corrupted; delete it and authenticate again.`,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw corrupted;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw corrupted;
  return parsed as AuthFile;
};

const writeAuth = async (configDirectory: string, auth: AuthFile): Promise<void> => {
  const path = authPath(configDirectory);
  const temporary = join(configDirectory, `.auth-${process.pid}-${crypto.randomUUID()}`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(auth)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
};

/** Reads one Provider's stored Credential, unvalidated; `undefined` before login. */
export const readCredential = async (
  configDirectory: string,
  providerKey: string,
): Promise<unknown> => (await readAuth(configDirectory))[providerKey];

/**
 * Runs `update` as a locked transaction over one Provider's entry, so a token
 * exchange can happen inside the lock without racing another process. Only this
 * Provider's entry is visible and replaceable; every other entry is preserved.
 * A replacement of `undefined` removes the entry.
 */
export const modifyCredential = async <A>(
  configDirectory: string,
  providerKey: string,
  update: (current: unknown) => Promise<readonly [unknown, A]> | readonly [unknown, A],
): Promise<A> => {
  await ensureDirectory(configDirectory);
  const lock = await acquireLock(configDirectory);
  try {
    const auth = await readAuth(configDirectory);
    const [next, value] = await update(auth[providerKey]);
    if (next === undefined) {
      const { [providerKey]: _, ...remaining } = auth;
      await writeAuth(configDirectory, remaining);
    } else {
      await writeAuth(configDirectory, { ...auth, [providerKey]: next });
    }
    return value;
  } finally {
    // Unlink before close: a failing close must not leave the lock behind.
    // Swallowed so cleanup never replaces the update's own error; a lock left behind
    // surfaces on the next operation as the acquire timeout, which names its path.
    await unlink(lockPath(configDirectory)).catch(() => {});
    await lock.close();
  }
};
