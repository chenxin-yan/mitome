import { Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import {
  type CredentialStoreError,
  modifyCredential,
  readCredential,
} from "../shared/credential-store.js";
import {
  isExpired,
  isRedirectedTokenFailure,
  isTemporaryTokenFailure,
  OAuthTokenError,
} from "../shared/oauth.js";
import { oauth, provider } from "./constants.js";
import { token, type OAuthCredentialFailure } from "./oauth-token.js";
import { OAuthCredentialSchema, type OAuthCredential } from "./types.js";

/** Works for any application; only the CLI half names a command. */
const remedy = `through your application; with the Mitome CLI, run \`mitome auth login --provider ${provider}\``;

export class CredentialUnavailableError extends Schema.TaggedError<
  CredentialUnavailableError,
  { readonly brand: unique symbol }
>()("CredentialUnavailableError", { message: Schema.String }) {}

export type CredentialError =
  | CredentialStoreError
  | CredentialUnavailableError
  | OAuthCredentialFailure;

const credentialFrom = (
  value: Schema.Json | undefined,
): Effect.Effect<OAuthCredential, CredentialUnavailableError> =>
  Schema.decodeUnknownEffect(OAuthCredentialSchema)(value).pipe(
    Effect.mapError(
      () =>
        new CredentialUnavailableError({
          message: `Codex Credential is unavailable. Authenticate ${remedy}.`,
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
  stateDirectory: string,
  credential: OAuthCredential,
): Effect.Effect<void, CredentialStoreError, FileSystem.FileSystem | Path.Path> =>
  modifyCredential(stateDirectory, provider, () => Effect.succeed([credential, undefined]));

export const loadCredential = (
  stateDirectory: string,
): Effect.Effect<
  OAuthCredential,
  CredentialStoreError | CredentialUnavailableError,
  FileSystem.FileSystem | Path.Path
> => Effect.flatMap(readCredential(stateDirectory, provider), credentialFrom);

/** A stored Credential is usable while it is not expiring and, after the Provider
 * rejected one, once another process has already rotated it. */
const usable = (
  current: OAuthCredential,
  rejected: OAuthCredential | undefined,
): Effect.Effect<boolean> =>
  Effect.map(
    isExpired(current),
    (expired) => !expired && (rejected === undefined || current.access !== rejected.access),
  );

/** Reads the Credential optimistically and, only when it is unusable, exchanges the
 * refresh token under the storage lock, rechecking first so a Credential already
 * rotated by another process is reused instead of burning its refresh token. */
const credential = Effect.fnUntraced(function* (
  stateDirectory: string,
  tokenUrl: string,
  rejected: OAuthCredential | undefined,
): Effect.fn.Return<
  OAuthCredential,
  CredentialError,
  HttpClient.HttpClient | FileSystem.FileSystem | Path.Path
> {
  const stored = yield* loadCredential(stateDirectory);
  if (yield* usable(stored, rejected)) {
    return stored;
  }
  return yield* modifyCredential(stateDirectory, provider, (locked) =>
    Effect.gen(function* () {
      // Interruptible until the exchange is sent: the endpoint may rotate the token from then on.
      const current = yield* Effect.interruptible(credentialFrom(locked));
      if (yield* Effect.interruptible(usable(current, rejected))) {
        return [locked, current];
      }
      const next = yield* token(tokenUrl, {
        grant_type: "refresh_token",
        refresh_token: current.refresh,
        client_id: oauth.clientId,
      }).pipe(
        Effect.mapError((error) =>
          error instanceof OAuthTokenError
            ? new OAuthTokenError({
                message: isRedirectedTokenFailure(error)
                  ? `Codex sign-in could not be refreshed: the token endpoint redirected instead of answering. ${error.message}`
                  : isTemporaryTokenFailure(error)
                    ? `Codex sign-in could not be refreshed right now; try again later. ${error.message}`
                    : `Codex sign-in expired or was revoked. Authenticate again ${remedy}. ${error.message}`,
                status: error.status,
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
  stateDirectory: string,
  tokenUrl: string,
): Layer.Layer<CredentialStore, never, HttpClient.HttpClient | FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    CredentialStore,
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      // Only these two: the rest of this context must not replace what a request brings.
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const onPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
      // The exchange's own RequestInit would hide the one the client was built with.
      const builtInit = yield* Effect.serviceOption(FetchHttpClient.RequestInit);
      return {
        loadCredential: onPlatform(loadCredential(stateDirectory)),
        credential: (rejected) =>
          onPlatform(credential(stateDirectory, tokenUrl, rejected)).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.provideServiceEffect(
              FetchHttpClient.RequestInit,
              Effect.map(Effect.serviceOption(FetchHttpClient.RequestInit), (current) => ({
                ...Option.getOrUndefined(builtInit),
                ...Option.getOrUndefined(current),
              })),
            ),
          ),
      };
    }),
  );
