/**
 * Official Anthropic Provider, authenticated by an API key or the Claude Console sign-in.
 *
 * @module @mitome/providers/anthropic
 */

import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { Effect, Layer } from "effect";
import { Provider, withModelRequestAccounting } from "@mitome/core";
import type { AuthCapability } from "@mitome/core";
import { apiKeyClientLayer } from "../shared/api-key-client.js";
import { platformLayer } from "../shared/platform.js";
import { runAnt } from "./login.js";
import { knownModelIds } from "./models.js";
import { defaultProfile, profileClientLayer } from "./profile.js";

export { knownModelIds, type KnownModelId } from "./models.js";
export { MissingCredentialError } from "../shared/api-key-client.js";
export { UnusableProfileError } from "./profile-error.js";

export interface AnthropicOptions {
  /** Environment variable containing the API key; defaults to ANTHROPIC_API_KEY. */
  readonly apiKeyEnv?: string;
  /** Anthropic API origin without `/v1`, primarily for controlled endpoints and proxies. */
  readonly baseUrl?: string;
  /**
   * The Claude Console profile `ant auth login --profile=<name>` writes, read when the API-key
   * variable is unset or empty; defaults to `mitome`.
   */
  readonly profile?: string;
}

/**
 * Creates the Anthropic Provider. An API key in `apiKeyEnv` wins; without one it reads the Claude
 * Console sign-in from the profile. Both bill the Console organisation at API rates.
 */
export const anthropic = (options: AnthropicOptions = {}) => {
  const apiKeyEnv = options.apiKeyEnv ?? "ANTHROPIC_API_KEY";
  const profile = options.profile ?? defaultProfile;
  // The client's request paths already start with /v1.
  const baseUrl = options.baseUrl?.replace(/\/+$/, "");
  const client = apiKeyClientLayer(
    apiKeyEnv,
    baseUrl ?? "https://api.anthropic.com",
    AnthropicClient.layer,
  ).pipe(
    Layer.catchTag("MissingCredentialError", () =>
      profileClientLayer(apiKeyEnv, profile, options.baseUrl),
    ),
  );
  return Provider.make("anthropic", {
    modelIds: knownModelIds,
    // The capability signs in and out of the profile this Provider reads, whichever it is.
    credential: { env: apiKeyEnv, capability: { module: import.meta.url, profile } },
    provision: (model) =>
      withModelRequestAccounting(
        "anthropic",
        // Anthropic allows at most 20 strict Tools per request and at most 24 optional parameters
        // across strict schemas (structured outputs documentation, "Explicit limits"), so Tools are
        // not strict by default; a Tool annotated `Tool.Strict` stays strict. Structured outputs stay
        // on so `generateObject` sends a native output format.
        AnthropicLanguageModel.layer({ model, config: { strictJsonSchema: false } }).pipe(
          Layer.provide(client),
        ),
      ),
  });
};

/**
 * Generic Host entry point satisfying Core's Auth capability contract: it runs Anthropic's `ant`
 * to sign the descriptor's profile in or out, and stores nothing itself.
 */
export const authenticate: AuthCapability["authenticate"] = (options) =>
  runAnt(options).pipe(Effect.provide(platformLayer));
