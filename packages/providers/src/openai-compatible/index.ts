import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai-compat";
import { Layer } from "effect";
import { type Credential, makeModel, type Model } from "@mitome/core";
import { makeApiKeyClient } from "../internal/api-key-client.js";

export { env } from "@mitome/core";
export type { Credential } from "@mitome/core";

export type ModelId = string;

export interface OpenAiCompatibleOptions {
  /** OpenAI-compatible Chat Completions API root. */
  readonly baseUrl: string;
}

/** Creates a canonical Model backed by an OpenAI-compatible Chat Completions endpoint. */
export const openaiCompatible = (
  model: ModelId,
  credential: Credential,
  options: OpenAiCompatibleOptions,
): Model => {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  return makeModel(
    OpenAiLanguageModel.layer({ model }).pipe(
      Layer.provide(makeApiKeyClient(credential, baseUrl, OpenAiClient.layer)),
    ),
    credential.name,
  );
};
