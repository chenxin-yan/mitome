import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai-compat";
import { Layer } from "effect";
import { makeProvider, type ValidProviderId } from "@mitome/core";
import { apiKeyClientLayer } from "../shared/api-key-client.js";

export const knownModelIds = [] as const;
export type KnownModelId = (typeof knownModelIds)[number];

export interface OpenAiCompatibleOptions<Id extends string = string> {
  /** Stable Provider id used in Qualified Model ids. */
  readonly id: Id;
  /** OpenAI-compatible Chat Completions API root. */
  readonly baseUrl: string;
  /** Optional environment variable containing the endpoint's API key. */
  readonly apiKeyEnv?: string;
}

/** Creates a configured Provider for an OpenAI-compatible endpoint. */
export const openaiCompatible = <const Id extends string>(
  options: OpenAiCompatibleOptions<Id> & {
    readonly id: ValidProviderId<Id>;
  },
) => {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  return makeProvider(options.id, knownModelIds, options.apiKeyEnv, (model) =>
    OpenAiLanguageModel.layer({ model }).pipe(
      Layer.provide(apiKeyClientLayer(options.apiKeyEnv, baseUrl, OpenAiClient.layer)),
    ),
  );
};
