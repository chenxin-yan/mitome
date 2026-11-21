/**
 * Official OpenAI Provider authenticated with an API-key Credential.
 *
 * @module @mitome/providers/openai
 */

import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { Provider, withModelRequestAccounting } from "@mitome/core";
import { apiKeyClientLayer } from "../shared/api-key-client.js";
import { transportLayer } from "./transport.js";
import { knownModelIds, knownModelMetadata } from "./models.js";

export { knownModelIds, type KnownModelId } from "./models.js";
export { MissingCredentialError } from "../shared/api-key-client.js";

export interface OpenAiOptions {
  /** Environment variable containing the API key; defaults to OPENAI_API_KEY. */
  readonly apiKeyEnv?: string;
  /** OpenAI Responses API root, primarily for controlled endpoints and proxies. */
  readonly baseUrl?: string;
  /** Response transport; defaults to WebSocket on Bun/Node and HTTP elsewhere. */
  readonly transport?: "http" | "websocket";
}

export const openai = (options: OpenAiOptions = {}) => {
  const apiKeyEnv = options.apiKeyEnv ?? "OPENAI_API_KEY";
  const baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const client = apiKeyClientLayer(apiKeyEnv, baseUrl, OpenAiClient.layer);
  return Provider.make("openai", {
    modelIds: knownModelIds,
    credential: apiKeyEnv,
    // Controlled generation uses the Responses HTTP endpoint in both transports, including the
    // native non-incremental fallback in WebSocket mode; the client reports each request.
    provision: (model) =>
      withModelRequestAccounting(
        "openai",
        transportLayer(options.transport, OpenAiLanguageModel.layer({ model }), client),
      ),
    models: knownModelMetadata,
  });
};
