import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai-compat";
import { Layer } from "effect";
import { makeProvider } from "@mitome/core";
import { makeApiKeyClient } from "../internal/api-key-client.js";

export interface OpenAiCompatibleOptions<Id extends string = string> {
  /** Stable Provider id used in qualified Model identifiers. */
  readonly id: Id;
  /** OpenAI-compatible Chat Completions API root. */
  readonly baseUrl: string;
  /** Optional environment variable containing the endpoint's API key. */
  readonly apiKeyEnv?: string;
}

/** Creates a configured Provider for an OpenAI-compatible endpoint. */
export const openaiCompatible = <const Id extends string>(
  options: OpenAiCompatibleOptions<Id> & {
    readonly id: Id & (Id extends "" | `${string}/${string}` ? never : unknown);
  },
) => {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  return makeProvider(options.id, [] as const, options.apiKeyEnv, (model) =>
    OpenAiLanguageModel.layer({ model }).pipe(
      Layer.provide(makeApiKeyClient(options.apiKeyEnv, baseUrl, OpenAiClient.layer)),
    ),
  );
};
