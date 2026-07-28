import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { exchangeToken } from "../../src/shared/oauth.js";

const provideClient = <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
  client: HttpClient.HttpClient,
) => Effect.provideService(effect, HttpClient.HttpClient, client);

describe("OAuth token exchange", () => {
  it.effect("uses HttpClient and the Effect Clock", () =>
    Effect.gen(function* () {
      let method = "";
      let url = "";
      let contentType: string | undefined;
      let body = "";
      const client = HttpClient.make((request, resolved) => {
        method = request.method;
        url = resolved.toString();
        contentType = request.headers["content-type"];
        if (request.body._tag === "Uint8Array") {
          body = new TextDecoder().decode(request.body.body);
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              access_token: "access",
              refresh_token: "refresh",
              expires_in: 60,
            }),
          ),
        );
      });

      const token = yield* provideClient(
        exchangeToken("https://auth.test/token", {
          grant_type: "refresh_token",
          refresh_token: "secret",
        }),
        client,
      );

      expect({ method, url, contentType, body }).toEqual({
        method: "POST",
        url: "https://auth.test/token",
        contentType: "application/x-www-form-urlencoded",
        body: "grant_type=refresh_token&refresh_token=secret",
      });
      expect(token).toEqual({ access: "access", refresh: "refresh", expires: 60_000 });
    }),
  );

  it.effect("times out while reading a hung token response", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(new ReadableStream({ start() {} }), {
              headers: { "content-type": "application/json" },
            }),
          ),
        ),
      );
      const fiber = yield* Effect.forkChild(
        Effect.flip(provideClient(exchangeToken("https://auth.test/token", {}), client)),
        { startImmediately: true },
      );
      yield* TestClock.adjust("15 seconds");
      expect((yield* Fiber.join(fiber))._tag).toBe("TimeoutError");
    }),
  );
});
