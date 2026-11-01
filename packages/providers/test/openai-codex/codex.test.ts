import { afterAll, describe, expect, test } from "vitest";
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
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { providerModel } from "@mitome/core";
import { serve, spawnRuntime, sse } from "../support.js";
import { writeCredential as writeCredentialEffect } from "../../src/openai-codex/credential-store.js";
import { codex } from "../../src/openai-codex/index.js";

type JsonObject = { readonly [key: string]: typeof Schema.Json.Type };
const JsonObject = Schema.Record(Schema.String, Schema.Json);

const textDeltas = (parts: ReadonlyArray<AiResponse.AnyPart>) =>
  parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : []));

const directories: Array<string> = [];
const writeCredential = (
  configDirectory: string,
  value: Parameters<typeof writeCredentialEffect>[1],
) => Effect.runPromise(writeCredentialEffect(configDirectory, value));
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
  const configDirectory = await mkdtemp(join(tmpdir(), "mitome-codex-sse-"));
  directories.push(configDirectory);
  await writeCredential(configDirectory, value);
  return configDirectory;
};

afterAll(async () => {
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * Two processes share one stored Credential and Turn concurrently against a backend that
 * `accepts` an Authorization header or answers 401. Every refresh exchange takes long
 * enough that the second process is past its optimistic read and waiting on the storage
 * lock when the first rotates, so only the locked recheck can keep it from exchanging again.
 */
const raceRotation = async (
  stored: ReturnType<typeof credential>,
  accepts: (authorization: string | null) => boolean,
) => {
  const configDirectory = await directory(stored);
  const refreshes: Array<string> = [];
  let arrivals = 0;
  const { promise: barrier, resolve: releaseBarrier } = Promise.withResolvers<void>();
  const tokenServer = await serve({
    async fetch(request) {
      if (new URL(request.url).pathname === "/barrier") {
        arrivals += 1;
        if (arrivals === 2) releaseBarrier();
        await barrier;
        return new Response("go");
      }
      const refresh = Schema.decodeUnknownSync(Schema.String)(
        (await request.formData()).get("refresh_token"),
      );
      refreshes.push(refresh);
      await setTimeout(6_000);
      if (refresh !== stored.refresh) return new Response("stale refresh", { status: 400 });
      return tokenResponse("race-account", "race-refresh");
    },
  });
  const server = await serve({
    fetch(request) {
      const authorization = request.headers.get("authorization");
      if (!accepts(authorization)) return new Response("", { status: 401 });
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
  const child = () =>
    spawnRuntime([
      "-e",
      `import { Effect, Stream } from "effect"; import { LanguageModel } from "effect/ai"; const { providerModel } = await import(${JSON.stringify(core)}); const { codex } = await import(${JSON.stringify(source)}); await fetch(${JSON.stringify(`http://127.0.0.1:${tokenServer.port}/barrier`)}); const provider = codex(${JSON.stringify({ configDirectory, baseUrl: `http://127.0.0.1:${server.port}`, tokenUrl: `http://127.0.0.1:${tokenServer.port}/oauth/token` })}); await Effect.runPromise(Stream.runDrain(LanguageModel.streamText({ prompt: "Hi" })).pipe(Effect.provide(providerModel(provider, "gpt-5.4"))));`,
    ]);
  try {
    const children = [child(), child()];
    const exits = await Promise.all(children.map((process) => process.exited));
    if (exits.some((code) => code !== 0)) {
      for (const failed of children) console.error(await new Response(failed.stderr).text());
    }
    const auth = JSON.parse(await readFile(join(configDirectory, "auth.json"), "utf8"));
    return { exits, refreshes, auth };
  } finally {
    void server.stop(true);
    void tokenServer.stop(true);
  }
};

describe("Codex SSE", () => {
  test("streams real SSE bytes incrementally end to end", async () => {
    const configDirectory = await directory();
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
              if (part.type === "text-delta") firstOutput();
            }),
          ),
          Effect.provide(
            providerModel(
              codex({ configDirectory, baseUrl: `http://127.0.0.1:${server.port}` }),
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
    const configDirectory = await directory();
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
              providerModel(
                codex({ configDirectory, baseUrl: `http://127.0.0.1:${server.port}` }),
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
    const configDirectory = await directory(credential("expired-access", refresh, 1));
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
              providerModel(
                codex({
                  configDirectory,
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
      if (!AiError.isAiError(error)) throw new Error("Expected an AiError");
      expect(error.message).toContain("mitome auth login");
      expect(error.message).toContain("HTTP 400; invalid_grant");
      expect(error.message).not.toContain(refresh);
      expect(error.reason).toMatchObject({
        _tag: "AuthenticationError",
        isRetryable: false,
        message: expect.stringContaining("mitome auth login"),
      });
      expect(requests).toBe(1);
    } finally {
      await server.stop(true);
    }
  });

  test("never reuses a stale rotating Credential across processes", async () => {
    const race = await raceRotation(credential("expired-access", "shared-refresh", 1), () => true);
    expect(race.exits).toEqual([0, 0]);
    expect(race.refreshes).toEqual(["shared-refresh"]);
    expect(race.auth).toMatchObject({
      "openai-codex": {
        access: jwt("race-account"),
        refresh: "race-refresh",
        accountId: "race-account",
      },
    });
  }, 15_000);

  test("reuses the Credential another process rotated after a stale 401", async () => {
    const stale = credential("stale-access", "shared-refresh");
    const race = await raceRotation(
      stale,
      (authorization) => authorization !== `Bearer ${stale.access}`,
    );
    expect(race.exits).toEqual([0, 0]);
    expect(race.refreshes).toEqual(["shared-refresh"]);
    expect(race.auth).toMatchObject({ "openai-codex": { refresh: "race-refresh" } });
  }, 15_000);
});
