/**
 * Best-effort Provider for a ChatGPT subscription through the unofficial Codex service endpoint.
 *
 * @module @mitome/providers/openai-codex
 */

import { type AuthCapability, Provider } from "@mitome/core";
import { provider } from "./constants.js";
import { login, logout } from "./login.js";
import { codexLayer } from "./model.js";
import { knownModelIds } from "./models.js";
import { type CodexOptions } from "./types.js";

export { login, logout } from "./login.js";
export { knownModelIds, type KnownModelId } from "./models.js";
export type { CodexOptions, LoginOptions, LogoutOptions, OAuthCredential } from "./types.js";

export const codex = (options: CodexOptions = {}) =>
  Provider.make(provider, {
    modelIds: knownModelIds,
    credential: { capability: { module: import.meta.url } },
    provision: (model) => codexLayer(model, options),
  });

/** Generic Host entry point satisfying Core's Auth capability contract. */
export const authenticate: AuthCapability["authenticate"] = (options) =>
  options.operation === "logout" ? logout(options) : login(options);
