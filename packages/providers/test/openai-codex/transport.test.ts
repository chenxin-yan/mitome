import { describe, expect, test } from "vitest";
import { Effect, Layer, Stream } from "effect";
import { LanguageModel, Prompt } from "effect/unstable/ai";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { memoryCredentialStoreLayer } from "../../src/openai-codex/credential-store.js";
import { streamText } from "../../src/openai-codex/transport.js";
import { type OAuthCredential } from "../../src/openai-codex/types.js";
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

const providerOptions = {
  prompt: Prompt.make("Hi"),
  tools: [],
} as unknown as LanguageModel.ProviderOptions;

const completed = () =>
  new Response(sse({ type: "response.completed" }), {
    headers: { "content-type": "text/event-stream" },
  });

const run = (
  initial: OAuthCredential,
  fetch: (request: Parameters<Parameters<typeof HttpClient.make>[0]>[0], url: URL) => Response,
  refresh: Parameters<typeof memoryCredentialStoreLayer>[1] = (current) => Effect.succeed(current),
) => {
  const client = HttpClient.make((request, url) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, fetch(request, url))),
  );
  return Effect.runPromise(
    Stream.runCollect(
      streamText("gpt-5.4", "https://codex.test/backend-api", "session-1", providerOptions),
    ).pipe(
      Effect.provide(
        Layer.merge(
          memoryCredentialStoreLayer(initial, refresh),
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
