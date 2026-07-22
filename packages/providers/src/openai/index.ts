import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { Effect, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { Socket } from "effect/unstable/socket";
import { type Credential, makeModel, type Model } from "@mitome/core";

export { env } from "@mitome/core";
export type { Credential } from "@mitome/core";

export const knownModelIds = [
  "gpt-5.6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
] as const;

export type KnownModelId = (typeof knownModelIds)[number];
export type ModelId = KnownModelId | (string & {});

export interface OpenAiOptions {
  /** OpenAI Responses API root, primarily for controlled endpoints and proxies. */
  readonly baseUrl?: string;
  /** Response transport; HTTP/SSE remains the default. */
  readonly transport?: "http" | "websocket";
}

// Deliberately unexported: it never appears in a public signature, and exporting it
// would drag Effect Schema/Cause types into the generated declarations.
class MissingCredentialError extends Schema.TaggedErrorClass<MissingCredentialError>()(
  "MissingCredentialError",
  { message: Schema.String },
) {}

/** Creates the canonical Model backed by OpenAI Responses streaming. */
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
      return OpenAiClient.layer({
        apiKey: Redacted.make(value),
        apiUrl: baseUrl,
      }).pipe(Layer.provide(FetchHttpClient.layer));
    }),
  );
  const languageModel = OpenAiLanguageModel.layer({ model });
  const modelLayer =
    options.transport === "websocket"
      ? Layer.merge(languageModel, OpenAiClient.layerWebSocketMode).pipe(
          Layer.provide(client),
          // globalThis.WebSocket exists in Bun, Node >=22, and edge runtimes, keeping
          // this subpath edge-capable per ADR-0021 without a platform-bun dependency.
          Layer.provide(Socket.layerWebSocketConstructorGlobal),
        )
      : languageModel.pipe(Layer.provide(client));
  return makeModel(modelLayer, credential.name);
};
