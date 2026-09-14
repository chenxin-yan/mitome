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
import { OAuthCredentialSchema, type OAuthCredential } from "./types.js";

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
  Schema.decodeUnknownEffect(OAuthCredentialSchema)(value).pipe(
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
    /** The stored Credential as-is; fails before login. */
    readonly loadCredential: Effect.Effect<OAuthCredential, CredentialError>;
    /** A usable Credential; `rejected` is the one the Provider just answered 401 to. */
    readonly credential: (
      rejected?: OAuthCredential,
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

/** A stored Credential is usable while it is not expiring, or, after the Provider
 * rejected one, once another process has already rotated it. */
const usable = (
  current: OAuthCredential,
  rejected: OAuthCredential | undefined,
): Effect.Effect<boolean> =>
  rejected === undefined
    ? Effect.map(isExpired(current), (expired) => !expired)
    : Effect.succeed(current.access !== rejected.access);

/** Reads the Credential optimistically and, only when it is unusable, exchanges the
 * refresh token under the storage lock, rechecking first so a Credential already
 * rotated by another process is reused instead of burning its refresh token. */
const credential = (
  configDirectory: string,
  tokenUrl: string,
  rejected: OAuthCredential | undefined,
): Effect.Effect<OAuthCredential, CredentialError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const stored = yield* loadCredential(configDirectory);
    if (yield* usable(stored, rejected)) return stored;
    return yield* modifyCredential(configDirectory, provider, (locked) =>
      Effect.gen(function* () {
        const current = yield* credentialFrom(locked);
        if (yield* usable(current, rejected)) return [current, current];
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
  });

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
        credential: (rejected) =>
          credential(configDirectory, tokenUrl, rejected).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
          ),
      };
    }),
  );
