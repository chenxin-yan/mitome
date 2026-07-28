import { modifyCredential, readCredential } from "../internal/credential-store.js";
import { isExpired } from "../internal/oauth.js";
import { oauth, provider } from "./constants.js";
import { token } from "./oauth-token.js";
import { type LogoutOptions, type OAuthCredential } from "./types.js";

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
    throw new Error("Codex Credential is unavailable. Run `mitome auth login` to authenticate.");
  }
  return value as OAuthCredential;
};

/** Stores the Codex Credential while preserving all other Provider entries. */
export const writeCredential = async (
  configDirectory: string,
  credential: OAuthCredential,
): Promise<void> => modifyCredential(configDirectory, provider, () => [credential, undefined]);

export const loadCredential = async (configDirectory: string): Promise<OAuthCredential> =>
  credentialFrom(await readCredential(configDirectory, provider));

/** Refreshes the rotating Credential under the storage lock; a Credential already
 * rotated by another process is reused instead of burning its refresh token. */
export const refreshCredential = async (
  configDirectory: string,
  tokenUrl: string,
  failedAccess: string | undefined,
  expiredOnly: boolean,
): Promise<OAuthCredential> =>
  modifyCredential(configDirectory, provider, async (stored) => {
    const current = credentialFrom(stored);
    if (failedAccess !== undefined && current.access !== failedAccess) return [current, current];
    if (expiredOnly && !isExpired(current)) return [current, current];
    const next = await token(tokenUrl, {
      grant_type: "refresh_token",
      refresh_token: current.refresh,
      client_id: oauth.clientId,
    });
    return [next, next];
  });

/** Removes only the Codex Credential. */
export const logout = async (options: LogoutOptions): Promise<void> => {
  await modifyCredential(options.configDirectory, provider, () => [undefined, undefined]);
  options.output?.("Logged out.\n");
};
