/**
 * Official Anthropic Provider authenticated with an API-key Credential.
 *
 * @module @mitome/providers/anthropic
 */

import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { Layer } from "effect";
import { Provider, withModelRequestAccounting } from "@mitome/core";
import { apiKeyClientLayer } from "../shared/api-key-client.js";
import { knownModelIds } from "./models.js";

export { knownModelIds, type KnownModelId } from "./models.js";
export { MissingCredentialError } from "../shared/api-key-client.js";

export interface AnthropicOptions {
  /** Environment variable containing the API key; defaults to ANTHROPIC_API_KEY. */
  readonly apiKeyEnv?: string;
  /** Anthropic API origin without `/v1`, primarily for controlled endpoints and proxies. */
  readonly baseUrl?: string;
}

export const anthropic = (options: AnthropicOptions = {}) => {
  const apiKeyEnv = options.apiKeyEnv ?? "ANTHROPIC_API_KEY";
  // The client's request paths already start with /v1.
  const baseUrl = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const client = apiKeyClientLayer(apiKeyEnv, baseUrl, AnthropicClient.layer);
  return Provider.make("anthropic", {
    modelIds: knownModelIds,
    credential: apiKeyEnv,
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
