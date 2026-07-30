import { describe, expect, test } from "vitest";
import { Effect, Layer, Stream } from "effect";
import { LanguageModel, Prompt } from "effect/unstable/ai";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";
import {
  CredentialStore,
  CredentialUnavailableError,
  type CredentialError,
} from "../../src/openai-codex/credential-store.js";
import { token } from "../../src/openai-codex/oauth-token.js";
import { requestFor } from "../../src/openai-codex/request.js";
import { streamText } from "../../src/openai-codex/transport.js";
import { type OAuthCredential } from "../../src/openai-codex/types.js";
import { CredentialStoreError } from "../../src/shared/credential-store.js";
import { sse } from "../support.js";

const credential = (
  access = "synthetic-access",
  expires = Date.now() + 3_600_000,
): OAuthCredential => ({
  type: "oauth",
  access,
  refresh: `${access}-refresh`,
  expires,
  accountId: `${access}-account`,
});

const memoryCredentialStoreLayer = (
  initial: OAuthCredential,
  refresh: (
    current: OAuthCredential,
    failedAccess: string | undefined,
    expiredOnly: boolean,
  ) => Effect.Effect<OAuthCredential, CredentialError> = (current) => Effect.succeed(current),
): Layer.Layer<CredentialStore> =>
  Layer.sync(CredentialStore, () => {
    let current = initial;
    return {
      loadCredential: Effect.sync(() => current),
      refreshCredential: (failedAccess, expiredOnly) =>
        refresh(current, failedAccess, expiredOnly).pipe(
          Effect.tap((next) =>
            Effect.sync(() => {
              current = next;
            }),
          ),
        ),
    };
  });

const failingCredentialStoreLayer = (error: CredentialError): Layer.Layer<CredentialStore> =>
  Layer.succeed(CredentialStore, {
    loadCredential: Effect.fail(error),
    refreshCredential: () => Effect.fail(error),
  });

const providerOptions = {
  prompt: Prompt.make("Hi"),
  tools: [],
} as unknown as LanguageModel.ProviderOptions;

const completed = () =>
  new Response(sse({ type: "response.completed" }), {
    headers: { "content-type": "text/event-stream" },
  });

type TestRequest = Parameters<Parameters<typeof HttpClient.make>[0]>[0];
type TestResponse = Response | HttpClientError.HttpClientError;

const clientFor = (fetch: (request: TestRequest, url: URL) => TestResponse) =>
  HttpClient.make((request, url) => {
    const response = fetch(request, url);
    return HttpClientError.isHttpClientError(response)
      ? Effect.fail(response)
      : Effect.succeed(HttpClientResponse.fromWeb(request, response));
  });

const runWithLayer = (
  layer: Layer.Layer<CredentialStore>,
  fetch: (request: TestRequest, url: URL) => TestResponse,
) => {
  const client = clientFor(fetch);
  return Effect.runPromise(
    Stream.runCollect(
      streamText("gpt-5.4", "https://codex.test/backend-api", "session-1", providerOptions),
    ).pipe(Effect.provide(Layer.merge(layer, Layer.succeed(HttpClient.HttpClient, client)))),
  );
};

const run = (
  initial: OAuthCredential,
  fetch: (request: TestRequest, url: URL) => TestResponse,
  refresh: (
    current: OAuthCredential,
    failedAccess: string | undefined,
    expiredOnly: boolean,
    client: ReturnType<typeof HttpClient.make>,
  ) => Effect.Effect<OAuthCredential, CredentialError> = (current) => Effect.succeed(current),
) => {
  const client = clientFor(fetch);
  return Effect.runPromise(
    Stream.runCollect(
      streamText("gpt-5.4", "https://codex.test/backend-api", "session-1", providerOptions),
    ).pipe(
      Effect.provide(
        Layer.merge(
          memoryCredentialStoreLayer(initial, (current, failedAccess, expiredOnly) =>
            refresh(current, failedAccess, expiredOnly, client),
          ),
          Layer.succeed(HttpClient.HttpClient, client),
        ),
      ),
    ),
  );
};

describe("Codex transport", () => {
  test("constructs the documented Provider request and Credential headers", async () => {
    let request:
      | {
          readonly method: string;
          readonly url: string;
          readonly headers: Record<string, string>;
          readonly body: Record<string, unknown>;
        }
      | undefined;

    await run(credential(), (outgoing, url) => {
      const body =
        outgoing.body._tag === "Uint8Array"
          ? (JSON.parse(new TextDecoder().decode(outgoing.body.body)) as Record<string, unknown>)
          : {};
      request = { method: outgoing.method, url: url.toString(), headers: outgoing.headers, body };
      return completed();
    });

    expect(request).toEqual({
      method: "POST",
      url: "https://codex.test/backend-api/codex/responses",
      headers: expect.objectContaining({
        authorization: "Bearer synthetic-access",
        "chatgpt-account-id": "synthetic-access-account",
        originator: "mitome",
        "openai-beta": "responses=experimental",
        accept: "text/event-stream",
        "content-type": "application/json",
        "session-id": "session-1",
        "x-client-request-id": "session-1",
        "user-agent": `mitome (${process.platform} ${process.arch})`,
      }),
      body: expect.objectContaining({
        model: "gpt-5.4",
        instructions: "",
        store: false,
        stream: true,
        input: [{ role: "user", content: "Hi" }],
        text: { verbosity: "low" },
        include: ["reasoning.encrypted_content"],
        prompt_cache_key: "session-1",
        tool_choice: "auto",
        parallel_tool_calls: true,
      }),
    });
    expect(request?.headers["session_id"]).toBeUndefined();
  });

  test("replays encrypted reasoning immediately before its function call", () => {
    const prompt = Prompt.fromMessages([
      Prompt.makeMessage("assistant", {
        content: [
          Prompt.makePart("reasoning", {
            text: "Checked the repository.",
            options: {
              openai: { itemId: "reasoning-1", encryptedContent: "encrypted-reasoning" },
            },
          }),
          Prompt.makePart("tool-call", {
            id: "call-1",
            name: "lookup",
            params: { query: "mitome" },
            providerExecuted: false,
          }),
        ],
      }),
    ]);

    expect(
      requestFor(
        "gpt-5.4",
        { prompt, tools: [] } as unknown as LanguageModel.ProviderOptions,
        "session-1",
      ),
    ).toMatchObject({
      include: ["reasoning.encrypted_content"],
      input: [
        {
          type: "reasoning",
          id: "reasoning-1",
          encrypted_content: "encrypted-reasoning",
          summary: [{ type: "summary_text", text: "Checked the repository." }],
        },
        {
          type: "function_call",
          call_id: "call-1",
          name: "lookup",
          arguments: '{"query":"mitome"}',
        },
      ],
    });
  });

  test("replays encrypted reasoning immediately before its assistant text", () => {
    const prompt = Prompt.fromMessages([
      Prompt.makeMessage("assistant", {
        content: [
          Prompt.makePart("reasoning", {
            text: "Checked the repository.",
            options: {
              openai: { itemId: "reasoning-1", encryptedContent: "encrypted-reasoning" },
            },
          }),
          Prompt.makePart("text", { text: "The repository is ready." }),
        ],
      }),
      Prompt.makeMessage("user", {
        content: [Prompt.makePart("text", { text: "Continue." })],
      }),
    ]);

    expect(
      requestFor(
        "gpt-5.4",
        { prompt, tools: [] } as unknown as LanguageModel.ProviderOptions,
        "session-1",
      ).input,
    ).toEqual([
      {
        type: "reasoning",
        id: "reasoning-1",
        encrypted_content: "encrypted-reasoning",
        summary: [{ type: "summary_text", text: "Checked the repository." }],
      },
      { role: "assistant", content: "The repository is ready." },
      { role: "user", content: "Continue." },
    ]);
  });

  test("preserves Credential auth and storage error taxonomy", async () => {
    const unavailable = new CredentialUnavailableError({
      message: "Codex Credential is unavailable. Run `mitome auth login` to authenticate.",
    });
    await expect(
      runWithLayer(failingCredentialStoreLayer(unavailable), () => completed()),
    ).rejects.toMatchObject({
      reason: {
        _tag: "AuthenticationError",
        isRetryable: false,
        message: expect.stringContaining("mitome auth login"),
      },
    });

    const storage = new CredentialStoreError({
      message: "Credential storage failed",
      code: "EACCES",
    });
    await expect(
      runWithLayer(failingCredentialStoreLayer(storage), () => completed()),
    ).rejects.toMatchObject({
      reason: {
        _tag: "UnknownError",
        description: "Credential storage failed (EACCES)",
        isRetryable: false,
      },
    });
  });

  test("preserves HttpClient request taxonomy", async () => {
    let requests = 0;
    await expect(
      run(credential(), (request) => {
        requests += 1;
        return new HttpClientError.HttpClientError({
          reason: new HttpClientError.InvalidUrlError({
            request,
            description: "invalid Codex URL",
          }),
        });
      }),
    ).rejects.toMatchObject({
      reason: { _tag: "NetworkError", reason: "InvalidUrlError", isRetryable: false },
    });
    expect(requests).toBe(1);
  });

  test("retries retryable pre-SSE failures at most twice", async () => {
    let networkRequests = 0;
    await run(credential(), (request) => {
      networkRequests += 1;
      return networkRequests === 1
        ? new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              description: "connection reset",
            }),
          })
        : completed();
    });
    expect(networkRequests).toBe(2);

    let transientRequests = 0;
    await run(credential(), () => {
      transientRequests += 1;
      return transientRequests === 1 ? new Response("busy", { status: 503 }) : completed();
    });
    expect(transientRequests).toBe(2);

    let exhaustedRequests = 0;
    await expect(
      run(credential(), () => {
        exhaustedRequests += 1;
        return new Response("busy", { status: 503 });
      }),
    ).rejects.toMatchObject({ reason: { _tag: "InternalProviderError" } });
    expect(exhaustedRequests).toBe(3);
  });

  test("does not retry non-retryable status or SSE failures", async () => {
    let invalidRequests = 0;
    await expect(
      run(credential(), () => {
        invalidRequests += 1;
        return new Response("invalid", { status: 400 });
      }),
    ).rejects.toMatchObject({ reason: { _tag: "InvalidRequestError" } });
    expect(invalidRequests).toBe(1);

    let streamRequests = 0;
    await expect(
      run(credential(), () => {
        streamRequests += 1;
        return new Response(
          sse({ type: "error", error: { message: "stream failed after headers" } }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    ).rejects.toMatchObject({ reason: { description: "stream failed after headers" } });
    expect(streamRequests).toBe(1);
  });

  test("refreshes an expired Credential and retries once after a 401", async () => {
    const proactive = credential("proactive-access");
    const retried = credential("retried-access");
    const refreshes: Array<{ failedAccess: string | undefined; expiredOnly: boolean }> = [];
    const authorizations: Array<string | undefined> = [];

    await run(
      credential("expired-access", 1),
      (request) => {
        authorizations.push(request.headers.authorization);
        return authorizations.length === 1 ? new Response("", { status: 401 }) : completed();
      },
      (_current, failedAccess, expiredOnly) =>
        Effect.sync(() => {
          refreshes.push({ failedAccess, expiredOnly });
          return refreshes.length === 1 ? proactive : retried;
        }),
    );

    expect(refreshes).toEqual([
      { failedAccess: undefined, expiredOnly: true },
      { failedAccess: "proactive-access", expiredOnly: false },
    ]);
    expect(authorizations).toEqual(["Bearer proactive-access", "Bearer retried-access"]);
  });

  test("drains a 401 response before refreshing", async () => {
    let drained = false;
    let drainedBeforeRefresh = false;
    let requests = 0;

    await run(
      credential(),
      () => {
        requests += 1;
        if (requests > 1) return completed();
        return new Response(
          new ReadableStream({
            pull(controller) {
              drained = true;
              controller.close();
            },
          }),
          { status: 401 },
        );
      },
      () =>
        Effect.sync(() => {
          drainedBeforeRefresh = drained;
          return credential("retried-access");
        }),
    );

    expect({ drainedBeforeRefresh, requests }).toEqual({ drainedBeforeRefresh: true, requests: 2 });
  });

  test("turns a refreshed token without an account claim into an AiError", async () => {
    const claimlessAccess = `header.${Buffer.from("{}").toString("base64url")}.signature`;

    await expect(
      run(
        credential("expired-access", 1),
        () =>
          Response.json({
            access_token: claimlessAccess,
            refresh_token: "refreshed-secret",
            expires_in: 3_600,
          }),
        (_current, _failedAccess, _expiredOnly, client) =>
          token("https://auth.test/token", {}).pipe(
            Effect.provideService(HttpClient.HttpClient, client),
          ),
      ),
    ).rejects.toMatchObject({
      reason: {
        _tag: "AuthenticationError",
        isRetryable: false,
        message: "OAuth access token did not contain an account.",
      },
    });
  });

  test("fails after one Credential refresh when the Provider keeps returning 401", async () => {
    let requests = 0;
    let refreshes = 0;

    await expect(
      run(
        credential(),
        () => {
          requests += 1;
          return new Response("", { status: 401 });
        },
        () =>
          Effect.sync(() => {
            refreshes += 1;
            return credential("retried-access");
          }),
      ),
    ).rejects.toMatchObject({ reason: { _tag: "AuthenticationError" } });
    expect({ requests, refreshes }).toEqual({ requests: 2, refreshes: 1 });
  });

  test("translates the Provider error body", async () => {
    await expect(
      run(credential(), () =>
        Response.json({ error: { message: "model not found" } }, { status: 400 }),
      ),
    ).rejects.toMatchObject({
      reason: {
        _tag: "InvalidRequestError",
        description: expect.stringContaining("model not found"),
      },
    });
  });

  test.each([
    [sse({ type: "error", error: { message: "subscriber rejected" } }), "subscriber rejected"],
    [
      sse({ type: "response.failed", response: { error: { message: "model rejected" } } }),
      "model rejected",
    ],
  ])("translates Provider SSE errors", async (body, description) => {
    await expect(
      run(
        credential(),
        () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
      ),
    ).rejects.toMatchObject({ reason: { description } });
  });
});
