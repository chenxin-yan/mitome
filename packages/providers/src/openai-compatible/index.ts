/**
 * Provider for a separately identified OpenAI-compatible endpoint.
 *
 * @module @mitome/providers/openai-compatible
 */

import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai-compat";
import { Layer } from "effect";
import { makeProvider, type ModelMetadataMap, type ValidProviderId } from "@mitome/core";
import { apiKeyClientLayer } from "../shared/api-key-client.js";

/** Empty: compatible endpoints share no catalog, so every endpoint-native Model id is accepted as-is. */
export const knownModelIds = [] as const;
/** Never inhabited; see `knownModelIds`. */
export type KnownModelId = (typeof knownModelIds)[number];

/** Options for `openaiCompatible()`. */
export interface OpenAiCompatibleOptions<Id extends string = string> {
  /** Stable Provider id used in Qualified Model ids. */
  readonly id: Id;
  /** OpenAI-compatible Chat Completions API root. */
  readonly baseUrl: string;
  /** Optional environment variable containing the endpoint's API key. */
  readonly apiKeyEnv?: string;
  /**
   * Context windows by endpoint-native Model id, such as `{ "llama-3.1-8b": { contextWindow: 128000 } }`.
   * Compatible endpoints share no catalog, so ids without an entry have no known window.
   */
  readonly models?: ModelMetadataMap;
}

/** Creates a configured Provider for an OpenAI-compatible endpoint. */
export const openaiCompatible = <const Id extends string>(
  options: OpenAiCompatibleOptions<Id> & {
    readonly id: ValidProviderId<Id>;
  },
) => {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  return makeProvider(
    options.id,
    knownModelIds,
    options.apiKeyEnv,
    (model) =>
      OpenAiLanguageModel.layer({ model }).pipe(
        Layer.provide(apiKeyClientLayer(options.apiKeyEnv, baseUrl, OpenAiClient.layer)),
      ),
    options.models,
  );
};
