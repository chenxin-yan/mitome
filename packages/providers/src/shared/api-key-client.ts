import { Config, ConfigProvider, Effect, Layer, Redacted } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/unstable/http";

/** Builds a Provider client Layer from an optional environment Credential and API root. */
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
          : yield* Config.redacted(apiKeyEnv).pipe(
              // A bare string: core surfaces it via String(cause) on TurnError.
              Effect.mapError(
                () => `Environment variable ${apiKeyEnv} is not set or empty` as const,
              ),
            );
      return layer({ apiUrl: baseUrl, apiKey }).pipe(Layer.provide(FetchHttpClient.layer));
    }),
  ).pipe(
    // Build a fresh fallback when the Layer runs so keys set after startup stay visible.
    Layer.provide(ConfigProvider.layerAdd(Effect.sync(() => ConfigProvider.fromEnv()))),
  );
