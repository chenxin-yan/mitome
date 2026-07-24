import { Effect, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/unstable/http";

// Deliberately unexported from any subpath: it never appears in a public signature,
// and exporting it would drag Effect Schema/Cause types into the generated declarations.
class MissingCredentialError extends Schema.TaggedErrorClass<MissingCredentialError>()(
  "MissingCredentialError",
  { message: Schema.String },
) {}

/** Builds a Provider client Layer from an optional environment Credential and API root. */
export const makeApiKeyClient = <Id, E>(
  apiKeyEnv: string | undefined,
  baseUrl: string,
  layer: (options: {
    readonly apiKey?: Redacted.Redacted;
    readonly apiUrl: string;
  }) => Layer.Layer<Id, E, HttpClient.HttpClient>,
): Layer.Layer<Id, E | MissingCredentialError> =>
  Layer.unwrap(
    Effect.gen(function* () {
      let apiKey: Redacted.Redacted | undefined;
      if (apiKeyEnv !== undefined) {
        // Read live rather than via Config: Effect's default ConfigProvider snapshots
        // process.env at first access, which would miss keys set after startup.
        const value = process.env[apiKeyEnv];
        if (value === undefined || value === "") {
          return yield* new MissingCredentialError({
            message: `Environment variable ${apiKeyEnv} is not set or empty`,
          });
        }
        apiKey = Redacted.make(value);
      }
      return layer({ apiUrl: baseUrl, ...(apiKey === undefined ? {} : { apiKey }) }).pipe(
        Layer.provide(FetchHttpClient.layer),
      );
    }),
  );
