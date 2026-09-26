import { OpenAiClient } from "@effect/ai-openai";
import { Layer, Predicate, Result, Schema } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { Socket } from "effect/unstable/socket";

const NodeProcess = Schema.Struct({ versions: Schema.Struct({ node: Schema.String }) });

// Effect's `Socket.layerWebSocketConstructorGlobal` rejects constructor options, but the
// Node and Bun globals accept the handshake `headers` option carrying Authorization.
const webSocketConstructor = Layer.succeed(Socket.WebSocketConstructor)((url, options) =>
  options === undefined || Predicate.isString(options) || Array.isArray(options)
    ? new globalThis.WebSocket(url, options)
    : new globalThis.WebSocket(
        url,
        options.headers === undefined ? {} : { headers: options.headers },
      ),
);

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
    "Bun" in globalThis ||
    Result.isSuccess(Schema.decodeUnknownResult(NodeProcess)(globalThis.process));
  const selected = transport ?? (supportsWebSocketHeaders ? "websocket" : "http");
  if (selected === "websocket" && !supportsWebSocketHeaders) {
    throw new Error("OpenAI WebSocket transport requires a Bun or Node server runtime");
  }
  return selected === "websocket"
    ? Layer.merge(languageModel, OpenAiClient.layerWebSocketMode).pipe(
        Layer.provide(client),
        Layer.provide(webSocketConstructor),
      )
    : languageModel.pipe(Layer.provide(client));
};
