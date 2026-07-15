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

// Deliberately unexported: it never appears in a public signature, and exporting it
// would drag Effect Schema/Cause types into the generated declarations.
class MissingCredentialError extends Schema.TaggedErrorClass<MissingCredentialError>()(
  "MissingCredentialError",
  { message: Schema.String },
) {}

/** Creates the canonical Model backed by OpenAI Chat Completions streaming. */
export const openai = (
  model: ModelId,
  credential: Credential,
  options: OpenAiOptions = {},
): Model => {
  const baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const client = Layer.unwrap(
    Effect.gen(function* () {
      // Read live rather than via Config: Effect's default ConfigProvider snapshots
      // process.env at first access, which would miss keys set after startup.
      const value = process.env[credential.name];
      if (value === undefined || value === "") {
        return yield* new MissingCredentialError({
          message: `Environment variable ${credential.name} is not set or empty`,
        });
      }
      return OpenAiClient.layer({ apiKey: Redacted.make(value), apiUrl: baseUrl }).pipe(
        Layer.provide(FetchHttpClient.layer),
      );
    }),
  );
  return makeModel(OpenAiLanguageModel.layer({ model }).pipe(Layer.provide(client)));
};
