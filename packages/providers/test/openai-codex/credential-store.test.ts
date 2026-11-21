import { afterAll, describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Layer, Predicate } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CredentialStore,
  fsCredentialStoreLayer,
  loadCredential,
  writeCredential,
} from "../../src/openai-codex/credential-store.js";
import { type OAuthCredential } from "../../src/openai-codex/types.js";
import { platformLayer } from "../../src/shared/platform.js";

const directories: Array<string> = [];
const tokenUrl = "https://auth.test/token";
const jwt = (accountId: string) =>
  `header.${Buffer.from(JSON.stringify({ chatgpt_account_id: accountId })).toString("base64url")}.signature`;

// `it.effect` runs on the TestClock, which starts at 0, so `expires` is measured from there.
const credential = (access: string, expires = 3_600_000): OAuthCredential => ({
  type: "oauth",
  access,
  refresh: `${access}-refresh`,
  expires,
  accountId: "synthetic-account",
});

const directory = (stored: OAuthCredential) =>
  Effect.promise(async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "mitome-codex-store-"));
    directories.push(stateDirectory);
    return stateDirectory;
  }).pipe(
    Effect.tap((stateDirectory) =>
      writeCredential(stateDirectory, stored).pipe(Effect.provide(platformLayer)),
    ),
  );

/** A token endpoint that records every refresh token it is asked to exchange. */
const tokenEndpoint = () => {
  const exchanged: Array<string> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const body = Predicate.isTagged(request.body, "Uint8Array")
        ? request.body.body
        : new Uint8Array();
      exchanged.push(
        new URLSearchParams(new TextDecoder().decode(body)).get("refresh_token") ?? "",
      );
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          access_token: jwt("rotated-account"),
          refresh_token: `rotated-refresh-${exchanged.length}`,
          expires_in: 3_600,
        }),
      );
    }),
  );
  return { exchanged, layer: Layer.succeed(HttpClient.HttpClient, client) };
};

/** One caller asking the filesystem adapter for a usable Credential. */
const usableCredential = (
  stateDirectory: string,
  endpoint: ReturnType<typeof tokenEndpoint>,
  rejected?: OAuthCredential,
) =>
  Effect.flatMap(CredentialStore, (store) => store.credential(rejected)).pipe(
    Effect.provide(
      fsCredentialStoreLayer(stateDirectory, tokenUrl).pipe(
        Layer.provide([endpoint.layer, platformLayer]),
      ),
    ),
  );

afterAll(async () => {
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

describe("Codex Credential freshness", () => {
  it.effect("reuses a stored Credential that is not expiring without exchanging", () =>
    Effect.gen(function* () {
      const endpoint = tokenEndpoint();
      const stateDirectory = yield* directory(credential("fresh-access"));

      const result = yield* usableCredential(stateDirectory, endpoint);

      expect(result.access).toBe("fresh-access");
      expect(endpoint.exchanged).toEqual([]);
    }),
  );

  it.effect("exchanges an expiring Credential and stores the rotated one", () =>
    Effect.gen(function* () {
      const endpoint = tokenEndpoint();
      const stateDirectory = yield* directory(credential("expiring-access", 1));

      const result = yield* usableCredential(stateDirectory, endpoint);

      expect(endpoint.exchanged).toEqual(["expiring-access-refresh"]);
      expect(result).toMatchObject({
        access: jwt("rotated-account"),
        refresh: "rotated-refresh-1",
      });
      expect(yield* loadCredential(stateDirectory).pipe(Effect.provide(platformLayer))).toEqual(
        result,
      );
    }),
  );

  it.effect("reuses an already-rotated Credential after a stale 401 without locking", () =>
    Effect.gen(function* () {
      const endpoint = tokenEndpoint();
      const rejected = credential("rejected-access");
      const stateDirectory = yield* directory(rejected);

      const first = yield* usableCredential(stateDirectory, endpoint, rejected);
      const second = yield* usableCredential(stateDirectory, endpoint, rejected);

      expect(endpoint.exchanged).toEqual(["rejected-access-refresh"]);
      expect(second).toEqual(first);
      expect(first.refresh).toBe("rotated-refresh-1");
    }),
  );

  it.effect("refreshes after a 401 when the stored Credential differs but is expiring", () =>
    Effect.gen(function* () {
      const endpoint = tokenEndpoint();
      const stateDirectory = yield* directory(credential("other-access", 1));

      const result = yield* usableCredential(
        stateDirectory,
        endpoint,
        credential("rejected-access"),
      );

      expect(endpoint.exchanged).toEqual(["other-access-refresh"]);
      expect(result.refresh).toBe("rotated-refresh-1");
    }),
  );
});
