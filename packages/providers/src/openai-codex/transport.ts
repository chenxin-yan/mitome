import { Effect, Schedule, Stream } from "effect";
import { AiError, LanguageModel } from "effect/unstable/ai";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { isExpired } from "../shared/oauth.js";
import { CredentialStore } from "./credential-store.js";
import { credentialError, httpError, requestFor } from "./request.js";
import { decodeStream } from "./sse.js";
import { type OAuthCredential } from "./types.js";

const requestRetrySchedule = Schedule.exponential("100 millis").pipe(Schedule.upTo({ times: 2 }));

export const streamText = (
  model: string,
  baseUrl: string,
  sessionId: string,
  options: LanguageModel.ProviderOptions,
) => {
  const execute = (
    store: CredentialStore["Service"],
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
    const response = HttpClient.execute(request).pipe(
      Effect.mapError(httpError),
      Effect.flatMap((response) => {
        if (
          (response.status >= 200 && response.status < 300) ||
          (response.status === 401 && !retried)
        ) {
          return Effect.succeed(response);
        }
        // The backend's error detail ("model not found", quota) beats a bare status.
        return response.text.pipe(
          Effect.orElseSucceed(() => ""),
          Effect.flatMap((body) =>
            Effect.fail(
              AiError.make({
                module: "OpenAI Codex",
                method: "streamText",
                reason: AiError.reasonFromHttpStatus(
                  body === ""
                    ? { status: response.status }
                    : { status: response.status, description: body.slice(0, 512) },
                ),
              }),
            ),
          ),
        );
      }),
      Effect.retry({
        while: (error) => error.isRetryable,
        schedule: requestRetrySchedule,
      }),
    );
    return response.pipe(
      Effect.flatMap((response) => {
        if (response.status === 401) {
          return response.text.pipe(
            Effect.ignore,
            Effect.andThen(store.refreshCredential(credential.access, false)),
            Effect.mapError(credentialError),
            Effect.flatMap((next) => execute(store, next, true)),
          );
        }
        return Effect.succeed(
          HttpClientResponse.stream(Effect.succeed(response)).pipe(Stream.mapError(httpError)),
        );
      }),
    );
  };
  return Stream.unwrap(
    Effect.gen(function* () {
      const store = yield* CredentialStore;
      const current = yield* store.loadCredential.pipe(Effect.mapError(credentialError));
      const credential = (yield* isExpired(current))
        ? yield* store.refreshCredential(undefined, true).pipe(Effect.mapError(credentialError))
        : current;
      return yield* execute(store, credential, false);
    }),
  ).pipe(decodeStream);
};
