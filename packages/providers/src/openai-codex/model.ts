import { Effect, Layer, Stream } from "effect";
import { AiError, LanguageModel, Response } from "effect/unstable/ai";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { configDirectory as processConfigDirectory, configDirectoryMessage } from "@mitome/core";
import { oauth } from "./constants.js";
import { loadCredential } from "./credential-store.js";
import { networkError } from "./request.js";
import { streamText } from "./transport.js";
import { type CodexOptions } from "./types.js";

/** Builds the Codex LanguageModel Layer for one Provider-native Model id. */
export const codexLayer = (
  model: string,
  options: CodexOptions = {},
): Layer.Layer<LanguageModel.LanguageModel, unknown> =>
  Layer.effect(
    LanguageModel.LanguageModel,
    Effect.gen(function* () {
      const configDirectory = options.configDirectory ?? processConfigDirectory();
      if (configDirectory === undefined) {
        return yield* Effect.fail(
          `${configDirectoryMessage} Required to locate Codex credentials.`,
        );
      }
      const baseUrl = (options.baseUrl ?? "https://chatgpt.com/backend-api").replace(/\/+$/, "");
      const sessionId = crypto.randomUUID();
      const httpClient = yield* HttpClient.HttpClient;
      const requestStream = (
        providerOptions: LanguageModel.ProviderOptions,
      ): Stream.Stream<Response.StreamPartEncoded, AiError.AiError> =>
        streamText(
          model,
          configDirectory,
          baseUrl,
          options.tokenUrl ?? oauth.tokenUrl,
          sessionId,
          providerOptions,
        ).pipe(Stream.provideService(HttpClient.HttpClient, httpClient));
      yield* loadCredential(configDirectory).pipe(Effect.mapError(networkError));
      return yield* LanguageModel.make({
        streamText: requestStream,
        generateText: (providerOptions) =>
          Stream.runCollect(requestStream(providerOptions)).pipe(
            Effect.map((parts) => {
              const text = [...parts]
                .filter((part) => part.type === "text-delta")
                .map((part) => part.delta)
                .join("");
              return [
                ...(text === "" ? [] : [Response.makePart("text", { text })]),
                ...[...parts].filter((part) => part.type === "tool-call"),
              ];
            }),
          ),
      });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
