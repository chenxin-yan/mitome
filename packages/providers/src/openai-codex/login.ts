import { Effect } from "effect";
import { type CredentialStoreError, modifyCredential } from "../shared/credential-store.js";
import {
  authorize,
  type OAuthAuthorizationError,
  type OAuthTokenFailure,
} from "../shared/oauth.js";
import { oauth, provider } from "./constants.js";
import { platformLayer } from "../shared/platform.js";
import { writeCredential } from "./credential-store.js";
import { accountCredential, type OAuthCredentialError } from "./oauth-token.js";
import { type LoginOptions, type LogoutOptions } from "./types.js";

/**
 * Runs Codex PKCE login and stores the resulting Credential. It also fails with any `Error` the
 * `input` Effect fails with, or the callback server's when it cannot listen for another reason
 * than a busy port.
 */
export const login = (
  options: LoginOptions,
): Effect.Effect<
  void,
  OAuthAuthorizationError | OAuthTokenFailure | OAuthCredentialError | CredentialStoreError | Error
> =>
  authorize(oauth, options).pipe(
    Effect.flatMap(accountCredential),
    Effect.flatMap((credential) => writeCredential(options.stateDirectory, credential)),
    Effect.provide(platformLayer),
  );

/** Removes only the Codex Credential. */
export const logout = (options: LogoutOptions): Effect.Effect<void, CredentialStoreError> =>
  modifyCredential(options.stateDirectory, provider, () =>
    Effect.succeed([undefined, undefined]),
  ).pipe(
    Effect.andThen(Effect.sync(() => options.output?.("Logged out.\n"))),
    Effect.provide(platformLayer),
  );
