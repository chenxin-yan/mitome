import { Effect } from "effect";
import { modifyCredential } from "../shared/credential-store.js";
import { authorize } from "../shared/oauth.js";
import { oauth, provider } from "./constants.js";
import { writeCredential } from "./credential-store.js";
import { credential } from "./oauth-token.js";
import { type LoginOptions, type LogoutOptions } from "./types.js";

/** Runs Codex PKCE login and stores the resulting Credential. */
export const login = async (options: LoginOptions): Promise<void> => {
  await Effect.runPromise(
    writeCredential(options.configDirectory, credential(await authorize(oauth, options))),
  );
};

/** Removes only the Codex Credential. */
export const logout = async (options: LogoutOptions): Promise<void> => {
  await Effect.runPromise(
    modifyCredential(options.configDirectory, provider, () =>
      Effect.succeed([undefined, undefined]),
    ),
  );
  options.output?.("Logged out.\n");
};
