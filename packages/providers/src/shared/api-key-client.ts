import { Config, ConfigProvider, Effect, Layer, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { reportModelRequest } from "@mitome/core";
import { rejectingModelRedirects } from "./model-http-client.js";

/**
 * The Provider's API-key environment variable is unset or empty when its Model is provisioned, and
 * it has no sign-in to read instead.
 */
export class MissingCredentialError extends Schema.TaggedError<
  MissingCredentialError,
  { readonly brand: unique symbol }
>()("MissingCredentialError", {
  apiKeyEnv: Schema.String,
  /** How to sign in instead, for a Provider that also reads a sign-in. */
  signIn: Schema.optional(Schema.String),
}) {
  override get message(): string {
    const missing = `Environment variable ${this.apiKeyEnv} is not set or empty`;
    return this.signIn === undefined
      ? missing
      : `${missing}. Set it to an API key, or ${this.signIn}.`;
  }
}

/**
 * The fetch HttpClient with every executed request reported to the controlled generation in
 * progress, immediately before it is sent, and never following a redirect (which would send
 * again, unreported). Only executions count: a WebSocket handshake that merely preprocesses a
 * request is not a Model request.
 */
export const reportingHttpClient = Layer.effect(
  HttpClient.HttpClient,
  Effect.flatMap(HttpClient.HttpClient, (client) =>
    rejectingModelRedirects(
      HttpClient.transform(client, (send) => Effect.andThen(reportModelRequest, send)),
    ),
  ),
).pipe(Layer.provide(FetchHttpClient.layer));

/**
 * Builds a Provider client Layer from an optional environment Credential and API root. The
 * client serves Model requests only, so each request it executes is reported.
 */
export const apiKeyClientLayer = <Id, E>(
  apiKeyEnv: string | undefined,
  baseUrl: string,
  layer: (options: {
    readonly apiKey?: Redacted.Redacted | undefined;
    readonly apiUrl: string;
  }) => Layer.Layer<Id, E, HttpClient.HttpClient>,
): Layer.Layer<Id, E | MissingCredentialError | Config.ConfigError> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const apiKey =
        apiKeyEnv === undefined
          ? undefined
          : // Only absent input is a missing key; a source failure stays a `ConfigError`.
            yield* Effect.flatMap(
              Config.option(Config.Redacted(apiKeyEnv)),
              Option.match({
                onNone: () => Effect.fail(new MissingCredentialError({ apiKeyEnv })),
                onSome: Effect.succeed,
              }),
            );
      return layer({ apiUrl: baseUrl, apiKey }).pipe(Layer.provide(reportingHttpClient));
    }),
  ).pipe(
    // Build a fresh fallback when the Layer runs so keys set after startup stay visible.
    Layer.provide(ConfigProvider.layerAdd(Effect.sync(() => ConfigProvider.fromEnv()))),
  );
