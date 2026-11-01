import { Effect, Option } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";

/**
 * A first-party Model HTTP client whose requests never follow redirects. The runtime's `fetch`
 * would otherwise re-send a redirected Model request below request accounting, so each request
 * runs with the native `FetchHttpClient.RequestInit` option `redirect: "error"`: a redirect fails
 * natively as a transport error after exactly the one counted send. Any `RequestInit` already in
 * the building or requesting context keeps its other options; only `redirect` is fixed, so a
 * caller's `RequestInit` cannot silently re-enable following. This applies to fetch-based clients
 * only; a replaced `FetchHttpClient.Fetch` or another transport is not covered. Credential and
 * token clients do not use it.
 */
export const rejectingModelRedirects = <E, R>(
  client: HttpClient.HttpClient.With<E, R>,
): Effect.Effect<HttpClient.HttpClient.With<E, R>> =>
  Effect.map(Effect.serviceOption(FetchHttpClient.RequestInit), (built) =>
    HttpClient.transform(client, (send) =>
      Effect.flatMap(Effect.serviceOption(FetchHttpClient.RequestInit), (current) =>
        Effect.provideService(send, FetchHttpClient.RequestInit, {
          ...Option.getOrUndefined(built),
          ...Option.getOrUndefined(current),
          redirect: "error",
        }),
      ),
    ),
  );
