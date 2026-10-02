import { Config, ConfigProvider, Effect, Layer, Redacted } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { reportModelRequest } from "@mitome/core";
import { rejectingModelRedirects } from "./model-http-client.js";

/**
 * The fetch HttpClient with every executed request reported to the controlled generation in
 * progress, immediately before it is sent, and never following a redirect (which would send
 * again, unreported). Only executions count: a WebSocket handshake that merely preprocesses a
 * request is not a Model request.
 */
const reportingHttpClient = Layer.effect(
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
): Layer.Layer<Id, E | string> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const apiKey =
        apiKeyEnv === undefined
          ? undefined
          : yield* Config.Redacted(apiKeyEnv).pipe(
              // A bare string, so whoever provisions the Model can report it verbatim.
              Effect.mapError(
                () => `Environment variable ${apiKeyEnv} is not set or empty` as const,
              ),
            );
      return layer({ apiUrl: baseUrl, apiKey }).pipe(Layer.provide(reportingHttpClient));
    }),
  ).pipe(
    // Build a fresh fallback when the Layer runs so keys set after startup stay visible.
    Layer.provide(ConfigProvider.layerAdd(Effect.sync(() => ConfigProvider.fromEnv()))),
  );
