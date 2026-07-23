import { OpenAiClient } from "@effect/ai-openai";
import { Layer } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { Socket } from "effect/unstable/socket";

/**
 * Wires the Responses transport for a provisioned language-model Layer:
 * WebSocket by default on Bun/Node server runtimes, HTTP elsewhere.
 */
export const transportLayer = (
  transport: "http" | "websocket" | undefined,
  languageModel: Layer.Layer<LanguageModel.LanguageModel, never, OpenAiClient.OpenAiClient>,
  client: Layer.Layer<OpenAiClient.OpenAiClient, unknown>,
): Layer.Layer<LanguageModel.LanguageModel, unknown> => {
  const supportsWebSocketHeaders =
    "Bun" in globalThis || (typeof process !== "undefined" && process.versions.node !== undefined);
  const selected = transport ?? (supportsWebSocketHeaders ? "websocket" : "http");
  if (selected === "websocket" && !supportsWebSocketHeaders) {
    throw new Error("OpenAI WebSocket transport requires a Bun or Node server runtime");
  }
  return selected === "websocket"
    ? Layer.merge(languageModel, OpenAiClient.layerWebSocketMode).pipe(
        Layer.provide(client),
        // Node and Bun accept the non-standard constructor options used for
        // Authorization headers; standards-only edge constructors do not.
        Layer.provide(Socket.layerWebSocketConstructorGlobal),
      )
    : languageModel.pipe(Layer.provide(client));
};
