import { Effect, Stream } from "effect";
import { AiError, LanguageModel } from "effect/unstable/ai";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { isExpired } from "../shared/oauth.js";
import { loadCredential, refreshCredential } from "./credential-store.js";
import { networkError, requestFor } from "./request.js";
import { decodeStream } from "./sse.js";
import { type OAuthCredential } from "./types.js";

export const streamText = (
  model: string,
  configDirectory: string,
  baseUrl: string,
  tokenUrl: string,
  sessionId: string,
  options: LanguageModel.ProviderOptions,
) => {
  const execute = (
    credential: OAuthCredential,
    retried: boolean,
  ): Effect.Effect<
    Stream.Stream<Uint8Array, AiError.AiError>,
    AiError.AiError,
    HttpClient.HttpClient
  > => {
    const request = HttpClientRequest.post(`${baseUrl}/codex/responses`).pipe(
      HttpClientRequest.setHeaders({
        Authorization: `Bearer ${credential.access}`,
        "chatgpt-account-id": credential.accountId,
        originator: "mitome",
        "User-Agent": `mitome (${process.platform} ${process.arch})`,
        "OpenAI-Beta": "responses=experimental",
        accept: "text/event-stream",
        "content-type": "application/json",
        "session-id": sessionId,
        "x-client-request-id": sessionId,
      }),
      HttpClientRequest.bodyJsonUnsafe(requestFor(model, options, sessionId)),
    );
    return HttpClient.execute(request).pipe(
      Effect.mapError(networkError),
      Effect.flatMap((response) => {
        if (response.status === 401 && !retried) {
          return refreshCredential(configDirectory, tokenUrl, credential.access, false).pipe(
            Effect.mapError(networkError),
            Effect.flatMap((next) => execute(next, true)),
          );
        }
        if (response.status >= 200 && response.status < 300) {
          return Effect.succeed(
            HttpClientResponse.stream(Effect.succeed(response)).pipe(Stream.mapError(networkError)),
          );
        }
        // The backend's error detail ("model not found", quota) beats a bare status.
        return response.text.pipe(
          Effect.orElseSucceed(() => ""),
          Effect.flatMap((body) =>
            Effect.fail(
              AiError.make({
                module: "OpenAI Codex",
                method: "streamText",
                reason: AiError.reasonFromHttpStatus({
                  status: response.status,
                  ...(body === "" ? {} : { description: body.slice(0, 512) }),
                }),
              }),
            ),
          ),
        );
      }),
    );
  };
  return Stream.unwrap(
    Effect.gen(function* () {
      const current = yield* loadCredential(configDirectory).pipe(Effect.mapError(networkError));
      const credential = (yield* isExpired(current))
        ? yield* refreshCredential(configDirectory, tokenUrl, undefined, true).pipe(
            Effect.mapError(networkError),
          )
        : current;
      return yield* execute(credential, false);
    }),
  ).pipe(decodeStream);
};
