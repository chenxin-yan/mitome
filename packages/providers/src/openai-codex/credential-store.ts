import { Context, Data, Effect, Layer, Schema } from "effect";
import { HttpClient } from "effect/unstable/http";
import {
  type CredentialStoreError,
  modifyCredential,
  readCredential,
} from "../shared/credential-store.js";
import { isExpired, OAuthTokenError } from "../shared/oauth.js";
import { oauth, provider } from "./constants.js";
import { token, type OAuthCredentialFailure } from "./oauth-token.js";
import { OAuthCredential } from "./types.js";

export class CredentialUnavailableError extends Data.TaggedError("CredentialUnavailableError")<{
  readonly message: string;
}> {}

export type CredentialError =
  | CredentialStoreError
  | CredentialUnavailableError
  | OAuthCredentialFailure;

const credentialFrom = (
  value: typeof Schema.Json.Type | undefined,
): Effect.Effect<OAuthCredential, CredentialUnavailableError> =>
  Schema.decodeUnknownEffect(OAuthCredential)(value).pipe(
    Effect.mapError(
      () =>
        new CredentialUnavailableError({
          message: "Codex Credential is unavailable. Run `mitome auth login` to authenticate.",
        }),
    ),
  );

export class CredentialStore extends Context.Service<
  CredentialStore,
  {
    readonly loadCredential: Effect.Effect<OAuthCredential, CredentialError>;
    readonly refreshCredential: (
      failedAccess: string | undefined,
      expiredOnly: boolean,
    ) => Effect.Effect<OAuthCredential, CredentialError>;
  }
>()("@mitome/providers/openai-codex/CredentialStore") {}

/** Stores the Codex Credential while preserving all other Provider entries. */
export const writeCredential = (
  configDirectory: string,
  credential: OAuthCredential,
): Effect.Effect<void, CredentialStoreError> =>
  modifyCredential(configDirectory, provider, () => Effect.succeed([credential, undefined]));

export const loadCredential = (
  configDirectory: string,
): Effect.Effect<OAuthCredential, CredentialStoreError | CredentialUnavailableError> =>
  Effect.flatMap(readCredential(configDirectory, provider), credentialFrom);

/** Refreshes the rotating Credential under the storage lock; a Credential already
 * rotated by another process is reused instead of burning its refresh token. */
const refreshCredential = (
  configDirectory: string,
  tokenUrl: string,
  failedAccess: string | undefined,
  expiredOnly: boolean,
): Effect.Effect<OAuthCredential, CredentialError, HttpClient.HttpClient> =>
  modifyCredential(configDirectory, provider, (stored) =>
    Effect.gen(function* () {
      const current = yield* credentialFrom(stored);
      if (failedAccess !== undefined && current.access !== failedAccess) return [current, current];
      if (expiredOnly && !(yield* isExpired(current))) return [current, current];
      const next = yield* token(tokenUrl, {
        grant_type: "refresh_token",
        refresh_token: current.refresh,
        client_id: oauth.clientId,
      }).pipe(
        Effect.mapError((error) =>
          error instanceof OAuthTokenError
            ? new OAuthTokenError({
                message: `Codex sign-in expired or was revoked. Run \`mitome auth login\` to authenticate again. ${error.message}`,
                cause: error,
              })
            : error,
        ),
      );
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
