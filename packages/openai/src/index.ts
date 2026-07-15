import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai-compat";
import { Effect, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { makeModel, type Model } from "@mitome/core";

export type KnownModelId = "gpt-4o" | "gpt-4o-mini" | "gpt-4.1" | "gpt-4.1-mini" | "o3" | "o4-mini";
export type ModelId = KnownModelId | (string & {});

export interface Credential {
  readonly name: string;
}

/** Declares the environment variable that supplies a provider credential at Session startup. */
export const env = (name: string): Credential => ({ name });

export interface OpenAiOptions {
  /** OpenAI-compatible API root, primarily for self-hosted compatible endpoints. */
  readonly baseUrl?: string;
}

export class MissingCredentialError extends Schema.TaggedErrorClass<MissingCredentialError>()(
  "MissingCredentialError",
  { message: Schema.String },
) {}

/** Creates the canonical Model backed by OpenAI Chat Completions streaming. */
export const openai = (
  model: ModelId,
  credential: Credential,
  options: OpenAiOptions = {},
): Model => {
  const baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const client = Layer.unwrap(
    Effect.gen(function* () {
      const value = process.env[credential.name];
      if (value === undefined || value === "") {
        return yield* new MissingCredentialError({
          message: `Missing environment variable ${credential.name}`,
        });
      }
      return OpenAiClient.layer({ apiKey: Redacted.make(value), apiUrl: baseUrl }).pipe(
        Layer.provide(FetchHttpClient.layer),
      );
    }),
  );
  return makeModel(OpenAiLanguageModel.layer({ model }).pipe(Layer.provide(client)));
};
