import { authorize } from "../shared/oauth.js";
import { oauth } from "./constants.js";
import { writeCredential } from "./credential-store.js";
import { credential } from "./oauth-token.js";
import { type LoginOptions } from "./types.js";

/** Runs Codex PKCE login and stores the resulting Credential. */
export const login = async (options: LoginOptions): Promise<void> => {
  await writeCredential(options.configDirectory, credential(await authorize(oauth, options)));
};
