import { Effect, Layer, Stream } from "effect";
import { AiError, LanguageModel, Response } from "effect/unstable/ai";
import {
  configDirectory as processConfigDirectory,
  configDirectoryMessage,
  makeModel,
  type CredentialDescriptor,
  type Model,
} from "@mitome/core";
import { defaultTokenUrl } from "./constants.js";
import { loadCredential } from "./credential-store.js";
import { type ModelId } from "./models.js";
import { networkError } from "./request.js";
import { streamText } from "./transport.js";
import { type CodexOptions } from "./types.js";

/** Creates the canonical Model backed by the unofficial ChatGPT Codex SSE Responses transport. */
export const makeCodex = (
  model: ModelId,
  credential: CredentialDescriptor,
  options: CodexOptions = {},
): Model => {
  const configDirectory = options.configDirectory ?? processConfigDirectory();
  if (configDirectory === undefined) throw new Error(configDirectoryMessage);
  const baseUrl = (options.baseUrl ?? "https://chatgpt.com/backend-api").replace(/\/+$/, "");
  const sessionId = crypto.randomUUID();
  const requestStream = (
    providerOptions: LanguageModel.ProviderOptions,
  ): Stream.Stream<Response.StreamPartEncoded, AiError.AiError> =>
    streamText(
      model,
      configDirectory,
      baseUrl,
      options.tokenUrl ?? defaultTokenUrl,
      sessionId,
      providerOptions,
    );
  return makeModel(
    Layer.effect(
      LanguageModel.LanguageModel,
      Effect.tryPromise({ try: () => loadCredential(configDirectory), catch: networkError }).pipe(
        Effect.flatMap(() =>
          LanguageModel.make({
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
          }),
        ),
      ),
    ),
    credential,
  );
};
