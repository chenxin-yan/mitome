/**
 * Provider for a separately identified OpenAI-compatible endpoint.
 *
 * @module @mitome/providers/openai-compatible
 */

import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai-compat";
import { Layer } from "effect";
import { Provider, withModelRequestAccounting } from "@mitome/core";
import { apiKeyClientLayer } from "../shared/api-key-client.js";

export { MissingCredentialError } from "../shared/api-key-client.js";

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
  readonly models?: Provider.ModelMetadataMap;
}

export const openaiCompatible = <const Id extends string>(
  options: OpenAiCompatibleOptions<Id> & {
    readonly id: Provider.ValidProviderId<Id>;
  },
) => {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  return Provider.make(options.id, {
    // Compatible endpoints share no catalog: every endpoint-native Model id is accepted as-is.
    modelIds: [] as const,
    credential: options.apiKeyEnv,
    provision: (model) =>
      withModelRequestAccounting(
        "openai-compatible",
        OpenAiLanguageModel.layer({ model }).pipe(
          Layer.provide(apiKeyClientLayer(options.apiKeyEnv, baseUrl, OpenAiClient.layer)),
        ),
      ),
    models: options.models,
  });
};
