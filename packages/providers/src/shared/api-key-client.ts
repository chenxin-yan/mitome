import { Effect, Layer, Redacted } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/unstable/http";

/** Builds a Provider client Layer from an optional environment Credential and API root. */
export const makeApiKeyClient = <Id, E>(
  apiKeyEnv: string | undefined,
  baseUrl: string,
  layer: (options: {
    readonly apiKey?: Redacted.Redacted;
    readonly apiUrl: string;
  }) => Layer.Layer<Id, E, HttpClient.HttpClient>,
): Layer.Layer<Id, E | string> =>
  Layer.unwrap(
    Effect.gen(function* () {
      let apiKey: Redacted.Redacted | undefined;
      if (apiKeyEnv !== undefined) {
        // Read live rather than via Config: Effect's default ConfigProvider snapshots
        // process.env at first access, which would miss keys set after startup.
        const value = process.env[apiKeyEnv];
        if (value === undefined || value === "") {
          // A bare string: core surfaces it via String(cause) on TurnError.
          return yield* Effect.fail(`Environment variable ${apiKeyEnv} is not set or empty`);
        }
        apiKey = Redacted.make(value);
      }
      return layer({ apiUrl: baseUrl, ...(apiKey === undefined ? {} : { apiKey }) }).pipe(
        Layer.provide(FetchHttpClient.layer),
      );
    }),
  );
