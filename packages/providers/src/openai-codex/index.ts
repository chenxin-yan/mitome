// Adapted from Pi (MIT License). Copyright (c) 2025 Mario Zechner.
import { type CredentialDescriptor, type Model } from "@mitome/core";
import { logout } from "./credential-store.js";
import { login } from "./login.js";
import { makeCodex } from "./model.js";
import { type ModelId } from "./models.js";
import { type CodexOptions } from "./types.js";

export { writeCredential, logout } from "./credential-store.js";
export { login } from "./login.js";
export { knownModelIds, type KnownModelId, type ModelId } from "./models.js";
export type { CodexOptions, LoginOptions, LogoutOptions, OAuthCredential } from "./types.js";

/** Declares the single ChatGPT Credential used by a Codex Model. */
export const oauth = (): CredentialDescriptor => ({
  capability: { module: import.meta.url },
});

/** Creates the canonical Model backed by the unofficial ChatGPT Codex SSE Responses transport. */
export const codex = (
  model: ModelId,
  credential: CredentialDescriptor = oauth(),
  options: CodexOptions = {},
): Model => makeCodex(model, credential, options);

type Input = () => Promise<string | undefined>;
type Output = (text: string) => void;

/** Generic CLI entry point selected through Core's provider-owned capability. */
export const authenticate = async (options: {
  readonly operation: "login" | "logout";
  readonly configDirectory: string;
  readonly input: Input;
  readonly output: Output;
  readonly openBrowser?: false;
}): Promise<void> => {
  if (options.operation === "logout") {
    await logout(options);
    return;
  }
  await login(options);
};
