import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { type Credential, makeModel, type Model } from "@mitome/core";
import { makeApiKeyClient } from "../internal/api-key-client.js";
import { transportLayer } from "./transport.js";

import { type ModelId } from "./models.js";

export { env } from "@mitome/core";
export type { Credential } from "@mitome/core";
export { knownModelIds, type KnownModelId, type ModelId } from "./models.js";

export interface OpenAiOptions {
  /** OpenAI Responses API root, primarily for controlled endpoints and proxies. */
  readonly baseUrl?: string;
  /** Response transport; defaults to WebSocket on Bun/Node and HTTP elsewhere. */
  readonly transport?: "http" | "websocket";
}

/** Creates the canonical Model backed by OpenAI Responses streaming. */
export const openai = (
  model: ModelId,
  credential: Credential,
  options: OpenAiOptions = {},
): Model => {
  const baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const client = makeApiKeyClient(credential, baseUrl, OpenAiClient.layer);
  return makeModel(
    transportLayer(options.transport, OpenAiLanguageModel.layer({ model }), client),
    credential.name,
  );
};
