import { afterAll, describe, expect, test } from "vite-plus/test";
import { setTimeout } from "node:timers/promises";
import { Effect, Layer, Schema, Stream } from "effect";
import {
  AiError,
  LanguageModel,
  Prompt,
  type Response as AiResponse,
  Tool,
  Toolkit,
} from "effect/ai";
import { FetchHttpClient } from "effect/http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Provider } from "@mitome/core";
import { serve, spawnRuntime, sse } from "../support.js";
import { writeCredential as writeCredentialEffect } from "../../src/openai-codex/credential-store.js";
import { platformLayer } from "../../src/shared/platform.js";
import { codex } from "../../src/openai-codex/index.js";

type JsonObject = { readonly [key: string]: Schema.Json };
const JsonObject = Schema.Record(Schema.String, Schema.Json);

const textDeltas = (parts: ReadonlyArray<AiResponse.AnyPart>) =>
  parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : []));

const directories: Array<string> = [];
const writeCredential = (
  stateDirectory: string,
  value: Parameters<typeof writeCredentialEffect>[1],
) =>
  Effect.runPromise(
    writeCredentialEffect(stateDirectory, value).pipe(Effect.provide(platformLayer)),
  );
const jwt = (accountId: string) =>
  `header.${Buffer.from(JSON.stringify({ chatgpt_account_id: accountId })).toString("base64url")}.signature`;
const credential = (
  access = "synthetic-access",
  refresh = "synthetic-refresh",
  expires = Date.now() + 3_600_000,
) => ({
  type: "oauth" as const,
  access,
  refresh,
  expires,
  accountId: "synthetic-account",
});

const tokenResponse = (accountId: string, refresh: string) =>
  Response.json({
    access_token: jwt(accountId),
    refresh_token: refresh,
    expires_in: 3_600,
  });

const directory = async (value = credential()) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "mitome-codex-sse-"));
  directories.push(stateDirectory);
  await writeCredential(stateDirectory, value);
  return stateDirectory;
};

afterAll(async () => {
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * Two processes share one stored Credential and Turn concurrently against a backend that
 * `accepts` an Authorization header or answers 401. The first refresh exchange is answered only
 * once the other process is waiting for the storage lock, so that process read the stale
 * Credential and only the locked recheck can keep it from exchanging again.
 */
const raceRotation = async (
  stored: ReturnType<typeof credential>,
  accepts: (authorization: string | null) => boolean,
) => {
  const stateDirectory = await directory(stored);
  const refreshes: Array<string> = [];
  const waiting = [Promise.withResolvers<void>(), Promise.withResolvers<void>()] as const;
  const tokenServer = await serve({
    async fetch(request) {
      // `/waiting/<child>` or `/token/<child>`: each child has its own token URL.
      const [, kind, child] = new URL(request.url).pathname.split("/");
      if (kind === "waiting") {
        waiting[Number(child)]?.resolve();
        return new Response("");
      }
      const refresh = Schema.decodeUnknownSync(Schema.String)(
        (await request.formData()).get("refresh_token"),
      );
      refreshes.push(refresh);
      // Only a failure bound: the other child waits for the lock as soon as it reads.
      const other = waiting[child === "0" ? 1 : 0].promise;
      if ((await Promise.race([other.then(() => true), setTimeout(5_000, false)])) === false) {
        return new Response("the other process never waited for the lock", { status: 500 });
      }
      if (refresh !== stored.refresh) {
        return new Response("stale refresh", { status: 400 });
      }
      return tokenResponse("race-account", "race-refresh");
    },
  });
  const server = await serve({
    fetch(request) {
      const authorization = request.headers.get("authorization");
      if (!accepts(authorization)) {
        return new Response("", { status: 401 });
      }
      expect(authorization).toBe(`Bearer ${jwt("race-account")}`);
      return new Response(
        sse({ type: "response.output_item.added", output_index: 0, item: { type: "message" } }) +
          sse({ type: "response.output_item.done", output_index: 0, item: { type: "message" } }) +
          sse({ type: "response.completed" }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const source = new URL("../../dist/openai-codex/index.js", import.meta.url).href;
  const core = new URL("../../node_modules/@mitome/core/dist/index.js", import.meta.url).href;
  const tokenUrl = (path: string) => `http://127.0.0.1:${tokenServer.port}/${path}`;
  // The storage lock retries after a 10 ms sleep on the Effect Clock, so the first such sleep
  // reports that this child found the lock held. The lock holder's token exchange also sleeps on
  // the Clock, for its 15 second timeout, which reports nothing.
  const child = (index: number) =>
    spawnRuntime([
      "-e",
      `import { Clock, Duration, Effect, Stream } from "effect";
import { LanguageModel } from "effect/ai";
const { Provider } = await import(${JSON.stringify(core)});
const { codex } = await import(${JSON.stringify(source)});
const provider = codex(${JSON.stringify({ stateDirectory, baseUrl: `http://127.0.0.1:${server.port}`, tokenUrl: tokenUrl(`token/${index}`) })});
await Effect.runPromise(Effect.gen(function* () {
  const clock = yield* Clock.Clock;
  let reported = false;
  const reporting = Object.create(clock);
  reporting.sleep = (duration) => {
    if (reported || Duration.toMillis(duration) !== 10) return clock.sleep(duration);
    reported = true;
    return Effect.andThen(Effect.promise(() => fetch(${JSON.stringify(tokenUrl(`waiting/${index}`))})), clock.sleep(duration));
  };
  yield* Stream.runDrain(LanguageModel.streamText({ prompt: "Hi" })).pipe(
    Effect.provide(Provider.model(provider, "gpt-5.4")),
    Effect.provideService(Clock.Clock, reporting),
  );
}));`,
    ]);
  try {
    const children = [child(0), child(1)];
    const exits = await Promise.all(children.map((process) => process.exited));
    if (exits.some((code) => code !== 0)) {
      for (const failed of children) {
        console.error(await new Response(failed.stderr).text());
      }
    }
    const auth = JSON.parse(await readFile(join(stateDirectory, "auth.json"), "utf8"));
    return { exits, refreshes, auth };
  } finally {
    void server.stop(true);
    void tokenServer.stop(true);
  }
};

describe("Codex SSE", () => {
  test("streams real SSE bytes incrementally end to end", async () => {
    const stateDirectory = await directory();
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    const server = await serve({
      fetch() {
        const added = sse({
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", id: "msg-1" },
        });
        return new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              const enqueue = (value: string) =>
                controller.enqueue(new TextEncoder().encode(value));
              enqueue(sse({ type: "response.created" }));
              enqueue(sse({ type: "response.in_progress" }));
              enqueue(added.slice(0, 17));
              enqueue(added.slice(17));
              enqueue(
                sse({
                  type: "response.output_text.delta",
                  item_id: "msg-1",
                  output_index: 0,
                  delta: "hel",
                }),
              );
              await released;
              enqueue(
                sse({
                  type: "response.output_text.delta",
                  item_id: "msg-1",
                  output_index: 0,
                  delta: "lo",
                }),
              );
              enqueue(
                sse({
                  type: "response.output_text.done",
                  item_id: "msg-1",
                  output_index: 0,
                  text: "hello",
                }),
              );
              enqueue(
                sse({
                  type: "response.output_item.done",
                  item_id: "msg-1",
                  output_index: 0,
                  item: { type: "message", id: "msg-1" },
                }),
              );
              enqueue(sse({ type: "response.completed" }));
              enqueue(sse("[DONE]"));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    try {
      const parts: Array<AiResponse.AnyPart> = [];
      const { promise: output, resolve: firstOutput } = Promise.withResolvers<void>();
      const generation = Effect.runPromise(
        LanguageModel.streamText({ prompt: "Hi" }).pipe(
          Stream.runForEach((part) =>
            Effect.sync(() => {
              parts.push(part);
              if (part.type === "text-delta") {
                firstOutput();
              }
            }),
          ),
          Effect.provide(
            Provider.model(
              codex({ stateDirectory, baseUrl: `http://127.0.0.1:${server.port}` }),
              "future-private-model",
            ),
          ),
        ),
      );
      await output;
      expect(textDeltas(parts)).toEqual(["hel"]);
      release();
      await generation;
      expect(textDeltas(parts)).toEqual(["hel", "lo"]);
      expect(parts.at(-1)).toMatchObject({
        type: "finish",
        reason: "stop",
        usage: { inputTokens: {}, outputTokens: {} },
      });
    } finally {
      await server.stop(true);
    }
  });

  test("replays encrypted reasoning before the paired Tool call on the next generation", async () => {
    const stateDirectory = await directory();
    const requests: Array<JsonObject> = [];
    const server = await serve({
      async fetch(request) {
        requests.push(Schema.decodeUnknownSync(JsonObject)(await request.json()));
        if (requests.length === 1) {
          return new Response(
            sse({
              type: "response.output_item.added",
              output_index: 0,
              item: { type: "reasoning", id: "reasoning-1", summary: [] },
            }) +
              sse({
                type: "response.output_item.done",
                output_index: 0,
                item: {
                  type: "reasoning",
                  id: "reasoning-1",
                  encrypted_content: "encrypted-reasoning",
                  summary: [{ type: "summary_text", text: "Checked the repository." }],
                },
              }) +
              sse({
                type: "response.output_item.added",
                output_index: 1,
                item: { type: "function_call", call_id: "call-1", name: "echo" },
              }) +
              sse({
                type: "response.function_call_arguments.done",
                output_index: 1,
                arguments: '{"text":"hello"}',
              }) +
              sse({
                type: "response.output_item.done",
                output_index: 1,
                item: { type: "function_call", arguments: '{"text":"hello"}' },
              }) +
              sse({ type: "response.completed" }),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        return new Response(
          sse({
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "message", id: "message-1" },
          }) +
            sse({ type: "response.output_text.delta", output_index: 0, delta: "done" }) +
            sse({
              type: "response.output_item.done",
              output_index: 0,
              item: { type: "message", id: "message-1" },
            }) +
            sse({ type: "response.completed" }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const echo = Tool.make("echo", {
      parameters: Schema.Struct({ text: Schema.String }),
      success: Schema.String,
    });
    const Echo = Toolkit.make(echo);
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const prompt = Prompt.make("Hi");
          const first = [
            ...(yield* Stream.runCollect(LanguageModel.streamText({ prompt, toolkit: Echo }))),
          ];
          const history = Prompt.concat(prompt, Prompt.fromResponseParts(first));
          const second = yield* Stream.runCollect(LanguageModel.streamText({ prompt: history }));
          return { first, second: [...second], history: history.content };
        }).pipe(
          Effect.provide(
            Layer.merge(
              Echo.toLayer({ echo: ({ text }) => Effect.succeed(text) }),
              Provider.model(
                codex({ stateDirectory, baseUrl: `http://127.0.0.1:${server.port}` }),
                "future-private-model",
              ),
            ),
          ),
        ),
      );

      expect(
        result.first.filter((part) => part.type === "tool-call" || part.type === "tool-result"),
      ).toMatchObject([
        { type: "tool-call", id: "call-1", name: "echo", params: { text: "hello" } },
        { type: "tool-result", id: "call-1", name: "echo", result: "hello", isFailure: false },
      ]);
      expect(textDeltas(result.second)).toEqual(["done"]);
      expect(result.second.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
      expect(requests).toHaveLength(2);
      expect(requests[1]?.input).toEqual([
        { role: "user", content: "Hi" },
        {
          type: "reasoning",
          id: "reasoning-1",
          encrypted_content: "encrypted-reasoning",
          summary: [{ type: "summary_text", text: "Checked the repository." }],
        },
        {
          type: "function_call",
          call_id: "call-1",
          name: "echo",
          arguments: '{"text":"hello"}',
        },
        { type: "function_call_output", call_id: "call-1", output: '"hello"' },
      ]);
      const assistant = result.history.find((message) => message.role === "assistant");
      const reasoning =
        assistant?.role === "assistant"
          ? assistant.content.find((part) => part.type === "reasoning")
          : undefined;
      expect(reasoning).toMatchObject({
        text: "Checked the repository.",
        options: {
          openai: { itemId: "reasoning-1", encryptedContent: "encrypted-reasoning" },
        },
      });
    } finally {
      await server.stop(true);
    }
  });

  test("surfaces revoked refresh grants as actionable Authentication errors", async () => {
    const refresh = "synthetic-refresh-secret";
    const stateDirectory = await directory(credential("expired-access", refresh, 1));
    let requests = 0;
    const server = await serve({
      fetch() {
        requests += 1;
        return Response.json(
          {
            error: "invalid_grant",
            error_description: `refresh ${refresh} was revoked`,
          },
          { status: 400 },
        );
      },
    });
    try {
      const error = await Effect.runPromise(
        Effect.flip(
          Stream.runDrain(LanguageModel.streamText({ prompt: "Hi" })).pipe(
            Effect.provide(
              Provider.model(
                codex({
                  stateDirectory,
                  baseUrl: `http://127.0.0.1:${server.port}`,
                  tokenUrl: `http://127.0.0.1:${server.port}/oauth/token`,
                }),
                "future-private-model",
              ),
            ),
          ),
        ),
      );

      expect(AiError.isAiError(error)).toBe(true);
      if (!AiError.isAiError(error)) {
        throw new Error("Expected an AiError");
      }
      expect(error.message).toContain(
        "Authenticate again through your application; with the Mitome CLI, run `mitome auth login --provider openai-codex`.",
      );
      expect(error.message).toContain("HTTP 400; invalid_grant");
      expect(error.message).not.toContain(refresh);
      expect(error.reason).toMatchObject({
        _tag: "AuthenticationError",
        isRetryable: false,
        message: expect.stringContaining("mitome auth login --provider openai-codex"),
      });
      expect(requests).toBe(1);
    } finally {
      await server.stop(true);
    }
  });

  test.each([
    [503, "InternalProviderError"],
    [429, "RateLimitError"],
  ])("reports a token endpoint HTTP %i as a temporary failure", async (status, tag) => {
    const stateDirectory = await directory(credential("expired-access", "refresh", 1));
    let requests = 0;
    const server = await serve({
      fetch() {
        requests += 1;
        return Response.json({ error: "temporarily_unavailable" }, { status });
      },
    });
    try {
      const error = await Effect.runPromise(
        Effect.flip(
          Stream.runDrain(LanguageModel.streamText({ prompt: "Hi" })).pipe(
            Effect.provide(
              Provider.model(
                codex({
                  stateDirectory,
                  baseUrl: `http://127.0.0.1:${server.port}`,
                  tokenUrl: `http://127.0.0.1:${server.port}/oauth/token`,
                }),
                "future-private-model",
              ),
            ),
          ),
        ),
      );

      expect(AiError.isAiError(error)).toBe(true);
      if (!AiError.isAiError(error)) {
        throw new Error("Expected an AiError");
      }
      expect(error.reason).toMatchObject({ _tag: tag, isRetryable: true });
      expect(error.message).not.toContain("Authenticate again");
      expect(requests).toBe(1);
    } finally {
      await server.stop(true);
    }
  });

  test("refreshes with the fetch options the Provider was built with", async () => {
    const stateDirectory = await directory(credential("expired-access", "refresh", 1));
    const tokenInits: Array<RequestInit | undefined> = [];
    await Effect.runPromise(
      Stream.runDrain(LanguageModel.streamText({ prompt: "Hi" })).pipe(
        Effect.provide(
          Provider.model(
            codex({
              stateDirectory,
              baseUrl: "https://codex.test",
              tokenUrl: "https://auth.test/token",
            }),
            "future-private-model",
          ).pipe(
            Layer.provide(
              Layer.succeed(FetchHttpClient.RequestInit, {
                cache: "no-store",
                headers: { "x-caller": "kept" },
              }),
            ),
            Layer.provide(
              Layer.succeed(FetchHttpClient.Fetch, async (url, init) => {
                if (new Request(url).url !== "https://auth.test/token") {
                  return new Response(sse({ type: "response.completed" }), {
                    headers: { "content-type": "text/event-stream" },
                  });
                }
                tokenInits.push(init);
                return tokenResponse("synthetic-account", "rotated-refresh");
              }),
            ),
          ),
        ),
      ),
    );
    expect(tokenInits.map((init) => [init?.cache, init?.redirect])).toEqual([
      ["no-store", "manual"],
    ]);
    expect(new Headers(tokenInits[0]?.headers).get("x-caller")).toBe("kept");
  });

  test("lets the fetch options of a request override those the Provider was built with", async () => {
    const stateDirectory = await directory(credential("expired-access", "refresh", 1));
    const tokenInits: Array<RequestInit | undefined> = [];
    await Effect.runPromise(
      Stream.runDrain(LanguageModel.streamText({ prompt: "Hi" })).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { cache: "no-store" }),
        Effect.provide(
          Provider.model(
            codex({
              stateDirectory,
              baseUrl: "https://codex.test",
              tokenUrl: "https://auth.test/token",
            }),
            "future-private-model",
          ).pipe(
            Layer.provide(
              Layer.succeed(FetchHttpClient.RequestInit, {
                cache: "default",
                headers: { "x-caller": "kept" },
              }),
            ),
            Layer.provide(
              Layer.succeed(FetchHttpClient.Fetch, async (url, init) => {
                if (new Request(url).url !== "https://auth.test/token") {
                  return new Response(sse({ type: "response.completed" }), {
                    headers: { "content-type": "text/event-stream" },
                  });
                }
                tokenInits.push(init);
                return tokenResponse("synthetic-account", "rotated-refresh");
              }),
            ),
          ),
        ),
      ),
    );
    expect(tokenInits.map((init) => [init?.cache, init?.redirect])).toEqual([
      ["no-store", "manual"],
    ]);
    expect(new Headers(tokenInits[0]?.headers).get("x-caller")).toBe("kept");
  });

  test.each([
    ["an expired Credential", credential("expired-access", "shared-refresh", 1)],
    ["a stale 401", credential("stale-access", "shared-refresh")],
  ])(
    "exchanges a rotating Credential once across processes racing on %s",
    { tags: ["dist"], timeout: 15_000 },
    async (_, stored) => {
      const race = await raceRotation(
        stored,
        (authorization) => authorization !== `Bearer ${stored.access}`,
      );
      expect(race.exits).toEqual([0, 0]);
      expect(race.refreshes).toEqual(["shared-refresh"]);
      expect(race.auth).toMatchObject({
        "openai-codex": {
          access: jwt("race-account"),
          refresh: "race-refresh",
          accountId: "race-account",
        },
      });
    },
  );
});

test("reads Credentials from the state directory by default", async () => {
  const keys = ["MITOME_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const;
  const previous = keys.map((key) => process.env[key]);
  const configRoot = await mkdtemp(join(tmpdir(), "mitome-codex-config-"));
  const stateRoot = await mkdtemp(join(tmpdir(), "mitome-codex-state-"));
  directories.push(configRoot, stateRoot);
  await writeCredential(join(stateRoot, "mitome"), credential());
  delete process.env.MITOME_HOME;
  process.env.XDG_CONFIG_HOME = configRoot;
  process.env.XDG_STATE_HOME = stateRoot;
  try {
    await Effect.runPromise(
      Effect.scoped(Layer.build(Provider.model(codex(), "future-private-model"))),
    );
  } finally {
    keys.forEach((key, index) => {
      const value = previous[index];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  }
});
