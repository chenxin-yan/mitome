import { Data, Effect, Schema } from "effect";
import { type HttpClient } from "effect/unstable/http";
import { modifyCredential, readCredential } from "../shared/credential-store.js";
import { isExpired } from "../shared/oauth.js";
import { oauth, provider } from "./constants.js";
import { token } from "./oauth-token.js";
import { type LogoutOptions, OAuthCredential } from "./types.js";

class CredentialUnavailableError extends Data.TaggedError("CredentialUnavailableError")<{
  readonly message: string;
}> {}

const credentialUnavailable = new CredentialUnavailableError({
  message: "Codex Credential is unavailable. Run `mitome auth login` to authenticate.",
});

const credentialFrom = (
  value: unknown,
): Effect.Effect<OAuthCredential, CredentialUnavailableError> =>
  Schema.decodeUnknownEffect(OAuthCredential)(value).pipe(
    Effect.mapError(() => credentialUnavailable),
  );

/** Stores the Codex Credential while preserving all other Provider entries. */
export const writeCredential = (
  configDirectory: string,
  credential: OAuthCredential,
): Effect.Effect<void, Error> =>
  modifyCredential(configDirectory, provider, () => [credential, undefined]);

export const loadCredential = (configDirectory: string): Effect.Effect<OAuthCredential, Error> =>
  Effect.flatMap(readCredential(configDirectory, provider), credentialFrom);

/** Refreshes the rotating Credential under the storage lock; a Credential already
 * rotated by another process is reused instead of burning its refresh token. */
export const refreshCredential = (
  configDirectory: string,
  tokenUrl: string,
  failedAccess: string | undefined,
  expiredOnly: boolean,
): Effect.Effect<OAuthCredential, Error, HttpClient.HttpClient> =>
  modifyCredential(configDirectory, provider, (stored) =>
    Effect.gen(function* () {
      const current = yield* credentialFrom(stored);
      if (failedAccess !== undefined && current.access !== failedAccess) return [current, current];
      if (expiredOnly && !(yield* isExpired(current))) return [current, current];
      const next = yield* token(tokenUrl, {
        grant_type: "refresh_token",
        refresh_token: current.refresh,
        client_id: oauth.clientId,
      });
      return [next, next];
    }),
  );

/** Removes only the Codex Credential. */
export const logout = async (options: LogoutOptions): Promise<void> => {
  await Effect.runPromise(
    modifyCredential(options.configDirectory, provider, () => [undefined, undefined]),
  );
  options.output?.("Logged out.\n");
};
