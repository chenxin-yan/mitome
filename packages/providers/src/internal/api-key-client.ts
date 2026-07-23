import { Effect, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/unstable/http";
import { type Credential } from "@mitome/core";

// Deliberately unexported from any subpath: it never appears in a public signature,
// and exporting it would drag Effect Schema/Cause types into the generated declarations.
class MissingCredentialError extends Schema.TaggedErrorClass<MissingCredentialError>()(
  "MissingCredentialError",
  { message: Schema.String },
) {}

/**
 * Builds a provider client Layer from an environment Credential and API root,
 * generic over the SDK's client-layer constructor.
 */
export const makeApiKeyClient = <Id, E>(
  credential: Credential,
  baseUrl: string,
  layer: (options: {
    readonly apiKey: Redacted.Redacted;
    readonly apiUrl: string;
  }) => Layer.Layer<Id, E, HttpClient.HttpClient>,
): Layer.Layer<Id, E | MissingCredentialError> =>
  Layer.unwrap(
    Effect.gen(function* () {
      // Read live rather than via Config: Effect's default ConfigProvider snapshots
      // process.env at first access, which would miss keys set after startup.
      const value = process.env[credential.name];
      if (value === undefined || value === "") {
        return yield* new MissingCredentialError({
          message: `Environment variable ${credential.name} is not set or empty`,
        });
      }
      return layer({ apiKey: Redacted.make(value), apiUrl: baseUrl }).pipe(
        Layer.provide(FetchHttpClient.layer),
      );
    }),
  );
