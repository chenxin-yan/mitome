import { Effect, Layer, Option, Schema, Stream } from "effect";
import { AiError, LanguageModel, Response } from "effect/ai";
import { FetchHttpClient, HttpClient } from "effect/http";
import {
  configDirectory as processConfigDirectory,
  configDirectoryMessage,
  withModelRequestAccounting,
} from "@mitome/core";
import { oauth } from "./constants.js";
import { CredentialStore, fsCredentialStoreLayer } from "./credential-store.js";
import { credentialError } from "./request.js";
import { rejectingModelRedirects } from "../shared/model-http-client.js";
import { streamText } from "./transport.js";
import { type CodexOptions } from "./types.js";

const RefusalMetadata = Schema.Struct({ openai: Schema.Struct({ refusal: Schema.String }) });
const refusalOf = (metadata: Response.TextEndPartEncoded["metadata"]) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(RefusalMetadata)(metadata))?.openai.refusal;

/**
 * Folds the complete Codex stream into non-streaming response parts, keeping reasoning, Tool
 * Calls, metadata and the finish part (with an explicit incomplete reason) rather than only text.
 */
const completeParts = (
  parts: Iterable<Response.StreamPartEncoded>,
): Array<Response.PartEncoded> => {
  const output: Array<Response.PartEncoded> = [];
  const texts = new Map<string, string>();
  const reasoning = new Map<string, string>();
  for (const part of parts) {
    switch (part.type) {
      case "text-start":
        texts.set(part.id, "");
        break;
      case "text-delta":
        texts.set(part.id, (texts.get(part.id) ?? "") + part.delta);
        break;
      case "text-end": {
        // Native keeps a refusal explanation in the text's `metadata.openai.refusal`.
        const refusal = refusalOf(part.metadata);
        const text = texts.get(part.id) ?? "";
        output.push(
          refusal === undefined
            ? { type: "text", text }
            : { type: "text", text, metadata: { openai: { refusal } } },
        );
        texts.delete(part.id);
        break;
      }
      case "reasoning-start":
        reasoning.set(part.id, "");
        break;
      case "reasoning-delta":
        reasoning.set(part.id, (reasoning.get(part.id) ?? "") + part.delta);
        break;
      case "reasoning-end":
        output.push({
          type: "reasoning",
          text: reasoning.get(part.id) ?? "",
          metadata: part.metadata,
        });
        reasoning.delete(part.id);
        break;
      case "tool-params-start":
      case "tool-params-delta":
      case "tool-params-end":
        // The complete Tool Call part follows its parameter deltas.
        break;
      case "error":
        // Codex fails the stream on errors rather than emitting error parts.
        break;
      case "tool-call":
      case "tool-result":
      case "tool-approval-request":
      case "file":
      case "source":
      case "response-metadata":
      case "finish":
        output.push(part);
        break;
    }
  }
  // Text whose item never closed before the terminal event is still part of the response.
  for (const text of texts.values()) output.push({ type: "text", text });
  return output;
};

/** Builds the Codex LanguageModel Layer for one Provider-native Model id. */
export const codexLayer = (model: string, options: CodexOptions = {}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const configDirectory = options.configDirectory ?? processConfigDirectory();
      if (configDirectory === undefined) {
        return yield* Effect.fail(
          `${configDirectoryMessage} Required to locate Codex credentials.`,
        );
      }
      const baseUrl = (options.baseUrl ?? "https://chatgpt.com/backend-api").replace(/\/+$/, "");
      const tokenUrl = options.tokenUrl ?? oauth.tokenUrl;
      return withModelRequestAccounting(
        "openai-codex",
        Layer.effect(
          LanguageModel.LanguageModel,
          Effect.gen(function* () {
            const sessionId = crypto.randomUUID();
            // Model requests only: the credential store keeps the plain client for token refreshes.
            const httpClient = yield* Effect.flatMap(
              HttpClient.HttpClient,
              rejectingModelRedirects,
            );
            const credentialStore = yield* CredentialStore;
            const requestStream = (
              providerOptions: LanguageModel.ProviderOptions,
            ): Stream.Stream<Response.StreamPartEncoded, AiError.AiError> =>
              streamText(model, baseUrl, sessionId, providerOptions).pipe(
                Stream.provideService(HttpClient.HttpClient, httpClient),
                Stream.provideService(CredentialStore, credentialStore),
              );
            yield* credentialStore.loadCredential.pipe(Effect.mapError(credentialError));
            return yield* LanguageModel.make({
              streamText: requestStream,
              generateText: (providerOptions) =>
                Stream.runCollect(requestStream(providerOptions)).pipe(Effect.map(completeParts)),
            });
          }),
        ),
      ).pipe(Layer.provide(fsCredentialStoreLayer(configDirectory, tokenUrl)));
    }),
  ).pipe(Layer.provideMerge(FetchHttpClient.layer));
