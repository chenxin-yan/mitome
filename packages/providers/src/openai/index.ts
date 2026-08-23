import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { makeProvider } from "@mitome/core";
import { apiKeyClientLayer } from "../shared/api-key-client.js";
import { transportLayer } from "./transport.js";
import { knownModelIds } from "./models.js";

export { knownModelIds, type KnownModelId } from "./models.js";

export interface OpenAiOptions {
  /** Environment variable containing the API key; defaults to OPENAI_API_KEY. */
  readonly apiKeyEnv?: string;
  /** OpenAI Responses API root, primarily for controlled endpoints and proxies. */
  readonly baseUrl?: string;
  /** Response transport; defaults to WebSocket on Bun/Node and HTTP elsewhere. */
  readonly transport?: "http" | "websocket";
}

/** Creates the configured OpenAI Provider. */
export const openai = (options: OpenAiOptions = {}) => {
  const apiKeyEnv = options.apiKeyEnv ?? "OPENAI_API_KEY";
  const baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const client = apiKeyClientLayer(apiKeyEnv, baseUrl, OpenAiClient.layer);
  return makeProvider("openai", knownModelIds, apiKeyEnv, (model) =>
    transportLayer(options.transport, OpenAiLanguageModel.layer({ model }), client),
  );
};
