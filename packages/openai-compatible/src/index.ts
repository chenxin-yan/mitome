import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai-compat";
import { Effect, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { makeModel, type Model } from "@mitome/core";

export type ModelId = string;

export interface Credential {
  readonly name: string;
}

/** Declares the environment variable that supplies a provider credential at Session startup. */
export const env = (name: string): Credential => ({ name });

export interface OpenAiCompatibleOptions {
  /** OpenAI-compatible Chat Completions API root. */
  readonly baseUrl: string;
}

class MissingCredentialError extends Schema.TaggedErrorClass<MissingCredentialError>()(
  "MissingCredentialError",
  { message: Schema.String },
) {}

/** Creates a canonical Model backed by an OpenAI-compatible Chat Completions endpoint. */
export const openaiCompatible = (
  model: ModelId,
  credential: Credential,
  options: OpenAiCompatibleOptions,
): Model => {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const client = Layer.unwrap(
    Effect.gen(function* () {
      const value = process.env[credential.name];
      if (value === undefined || value === "") {
        return yield* new MissingCredentialError({
          message: `Environment variable ${credential.name} is not set or empty`,
        });
      }
      return OpenAiClient.layer({
        apiKey: Redacted.make(value),
        apiUrl: baseUrl,
      }).pipe(Layer.provide(FetchHttpClient.layer));
    }),
  );
  return makeModel(OpenAiLanguageModel.layer({ model }).pipe(Layer.provide(client)), {
    kind: "env",
    name: credential.name,
  });
};
