import { Context, Data, Effect, Layer, Schema } from "effect";
import { HttpClient } from "effect/unstable/http";
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

export class CredentialStore extends Context.Service<
  CredentialStore,
  {
    readonly loadCredential: Effect.Effect<OAuthCredential, Error>;
    readonly refreshCredential: (
      failedAccess: string | undefined,
      expiredOnly: boolean,
    ) => Effect.Effect<OAuthCredential, Error>;
  }
>()("@mitome/providers/openai-codex/CredentialStore") {}

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

export const fsCredentialStoreLayer = (
  configDirectory: string,
  tokenUrl: string,
): Layer.Layer<CredentialStore, never, HttpClient.HttpClient> =>
  Layer.effect(
    CredentialStore,
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      return {
        loadCredential: loadCredential(configDirectory),
        refreshCredential: (failedAccess, expiredOnly) =>
          refreshCredential(configDirectory, tokenUrl, failedAccess, expiredOnly).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
          ),
      };
    }),
  );

export const memoryCredentialStoreLayer = (
  initial: OAuthCredential,
  refresh: (
    current: OAuthCredential,
    failedAccess: string | undefined,
    expiredOnly: boolean,
  ) => Effect.Effect<OAuthCredential, Error> = (current) => Effect.succeed(current),
): Layer.Layer<CredentialStore> =>
  Layer.sync(CredentialStore, () => {
    let current = initial;
    return {
      loadCredential: Effect.sync(() => current),
      refreshCredential: (failedAccess, expiredOnly) =>
        refresh(current, failedAccess, expiredOnly).pipe(
          Effect.tap((next) =>
            Effect.sync(() => {
              current = next;
            }),
          ),
        ),
    };
  });

/** Removes only the Codex Credential. */
export const logout = async (options: LogoutOptions): Promise<void> => {
  await Effect.runPromise(
    modifyCredential(options.configDirectory, provider, () => [undefined, undefined]),
  );
  options.output?.("Logged out.\n");
};
