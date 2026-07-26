import { chmod, mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { clientId, provider } from "./constants.js";
import { isExpired, token } from "./oauth-token.js";
import { type LogoutOptions, type OAuthCredential } from "./types.js";

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
  try {
    const parsed: unknown = JSON.parse(await readFile(authPath(configDirectory), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Credential storage is invalid.");
    }
    return parsed as AuthFile;
  } catch (error) {
    if (isMissing(error)) return {};
    throw error;
  }
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

const modifyAuth = async <A>(
  configDirectory: string,
  update: (auth: AuthFile) => Promise<readonly [AuthFile, A]> | readonly [AuthFile, A],
): Promise<A> => {
  await ensureDirectory(configDirectory);
  const lock = await acquireLock(configDirectory);
  try {
    const [auth, value] = await update(await readAuth(configDirectory));
    await writeAuth(configDirectory, auth);
    return value;
  } finally {
    // Unlink before close: a failing close must not leave the lock behind.
    await unlink(lockPath(configDirectory)).catch((error: unknown) => {
      // The lock may have been removed externally; don't mask the update's own error.
      if (!isMissing(error)) throw error;
    });
    await lock.close();
  }
};

const updateAuth = async (
  configDirectory: string,
  update: (auth: AuthFile) => Promise<AuthFile> | AuthFile,
): Promise<void> => {
  await modifyAuth(configDirectory, async (auth) => [await update(auth), undefined]);
};

/** Stores one provider Credential while preserving all other provider entries. */
export const writeCredential = async (
  configDirectory: string,
  providerKey: string,
  credential: OAuthCredential,
): Promise<void> => updateAuth(configDirectory, (auth) => ({ ...auth, [providerKey]: credential }));

const credentialFrom = (value: unknown): OAuthCredential => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    value.type !== "oauth" ||
    !("access" in value) ||
    typeof value.access !== "string" ||
    !("refresh" in value) ||
    typeof value.refresh !== "string" ||
    !("expires" in value) ||
    typeof value.expires !== "number" ||
    !("accountId" in value) ||
    typeof value.accountId !== "string"
  ) {
    throw new Error("Codex Credential is unavailable.");
  }
  return value as OAuthCredential;
};

export const loadCredential = async (configDirectory: string): Promise<OAuthCredential> =>
  credentialFrom((await readAuth(configDirectory))[provider]);

/** Refreshes the rotating Credential under the storage lock; a Credential already
 * rotated by another process is reused instead of burning its refresh token. */
export const refreshCredential = async (
  configDirectory: string,
  tokenUrl: string,
  failedAccess: string | undefined,
  expiredOnly: boolean,
): Promise<OAuthCredential> =>
  modifyAuth(configDirectory, async (auth) => {
    const current = credentialFrom(auth[provider]);
    if (failedAccess !== undefined && current.access !== failedAccess) return [auth, current];
    if (expiredOnly && !isExpired(current)) return [auth, current];
    const next = await token(tokenUrl, {
      grant_type: "refresh_token",
      refresh_token: current.refresh,
      client_id: clientId,
    });
    return [{ ...auth, [provider]: next }, next];
  });

/** Removes only the Codex Credential. */
export const logout = async (options: LogoutOptions): Promise<void> => {
  await updateAuth(options.configDirectory, (auth) => {
    const { [provider]: _, ...remaining } = auth;
    return remaining;
  });
  options.output?.("Logged out.\n");
};
