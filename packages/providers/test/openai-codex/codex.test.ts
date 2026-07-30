import { afterAll, describe, expect, test } from "vitest";
import { setTimeout } from "node:timers/promises";
import { Effect, Schema, Stream } from "effect";
import { AiError, Tool, Toolkit } from "effect/unstable/ai";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSession, TurnError } from "@mitome/core";
import { agent as definition, serve, spawnRuntime, sse } from "../support.js";
import { writeCredential as writeCredentialEffect } from "../../src/openai-codex/credential-store.js";
import { codex } from "../../src/openai-codex/index.js";

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

describe("Codex SSE", () => {
  test("streams real SSE bytes incrementally end to end", async () => {
    const configDirectory = await directory();
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
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
              enqueue(
                sse({
                  type: "response.output_item.added",
                  output_index: 99,
                  item: { type: "future_item" },
                }),
              );
              enqueue(
                sse({
                  type: "response.output_item.done",
                  output_index: 99,
                  item: { type: "future_item" },
                }),
              );
              enqueue(added.slice(0, 17));
              enqueue(added.slice(17));
              enqueue(
                sse({ type: "response.content_part.added", item_id: "msg-1", output_index: 0 }),
              );
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
      const events: Array<unknown> = [];
      let firstOutput!: () => void;
      const output = new Promise<void>((resolve) => (firstOutput = resolve));
      const turn = Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* createSession(
              definition(
                codex({
                  configDirectory,
                  baseUrl: `http://127.0.0.1:${server.port}`,
                }),
                "future-private-model",
              ),
            );
            yield* Stream.runForEach(session.prompt("Hi"), (event) =>
              Effect.sync(() => {
                events.push(event);
                if (event.type === "model-output") firstOutput();
              }),
            );
          }),
        ),
      );
      await output;
      expect(events).toEqual([{ type: "model-output", text: "hel" }]);
      release();
      await turn;
      expect(events).toEqual([
        { type: "model-output", text: "hel" },
        { type: "model-output", text: "lo" },
        { type: "response-complete" },
      ]);
    } finally {
      void server.stop(true);
    }
  });

  test("replays encrypted reasoning before the paired Tool call on the next Step", async () => {
    const configDirectory = await directory();
    const requests: Array<Record<string, unknown>> = [];
    const server = await serve({
      async fetch(request) {
        requests.push((await request.json()) as Record<string, unknown>);
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
    try {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* createSession(
              definition(
                codex({
                  configDirectory,
                  baseUrl: `http://127.0.0.1:${server.port}`,
                }),
                "future-private-model",
                [
                  {
                    name: "echo",
                    toolkit: Toolkit.make(echo),
                    handlers: {
                      echo: (params) => Effect.succeed((params as { readonly text: string }).text),
                    },
                  },
                ],
              ),
            );
            const events = yield* Stream.runCollect(session.prompt("Hi"));
            return { events: [...events], history: session.history() };
          }),
        ),
      );

      expect(result.events).toEqual([
        { type: "reasoning", text: "Checked the repository." },
        { type: "tool-call", id: "call-1", name: "echo", params: { text: "hello" } },
        { type: "tool-result", id: "call-1", name: "echo", result: "hello", isFailure: false },
        { type: "model-output", text: "done" },
        { type: "response-complete" },
      ]);
      expect(JSON.stringify(result.events)).not.toContain("encrypted-reasoning");
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
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* createSession(
              definition(
                codex({
                  configDirectory,
                  baseUrl: `http://127.0.0.1:${server.port}`,
                  tokenUrl: `http://127.0.0.1:${server.port}/oauth/token`,
                }),
                "future-private-model",
              ),
            );
            return yield* Effect.flip(Stream.runDrain(session.prompt("Hi")));
          }),
        ),
      );

      expect(error).toBeInstanceOf(TurnError);
      expect(error.message).toContain("mitome auth login");
      expect(error.message).toContain("HTTP 400; invalid_grant");
      expect(error.message).not.toContain(refresh);
      expect(AiError.isAiError(error.cause)).toBe(true);
      if (!AiError.isAiError(error.cause)) throw new Error("Expected an AiError cause");
      expect(error.cause.reason).toMatchObject({
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
    const configDirectory = await directory(credential("expired-access", "shared-refresh", 1));
    const refreshes: Array<string> = [];
    let arrivals = 0;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => (releaseBarrier = resolve));
    const tokenServer = await serve({
      async fetch(request) {
        if (new URL(request.url).pathname === "/barrier") {
          arrivals += 1;
          if (arrivals === 2) releaseBarrier();
          await barrier;
          return new Response("go");
        }
        const refresh = (await request.formData()).get("refresh_token") as string;
        refreshes.push(refresh);
        await setTimeout(6_000);
        if (refresh !== "shared-refresh") return new Response("stale refresh", { status: 400 });
        return tokenResponse("race-account", "race-refresh");
      },
    });
    const server = await serve({
      fetch(request) {
        expect(request.headers.get("authorization")).toBe(`Bearer ${jwt("race-account")}`);
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
        `import { Effect, Stream } from "effect"; const { createSession } = await import(${JSON.stringify(core)}); const { codex } = await import(${JSON.stringify(source)}); await fetch(${JSON.stringify(`http://127.0.0.1:${tokenServer.port}/barrier`)}); const provider = codex(${JSON.stringify({ configDirectory, baseUrl: `http://127.0.0.1:${server.port}`, tokenUrl: `http://127.0.0.1:${tokenServer.port}/oauth/token` })}); await Effect.runPromise(Effect.scoped(Effect.gen(function* () { const session = yield* createSession({ providers: [provider], model: "openai-codex/gpt-5.4", plugins: [] }); yield* Stream.runDrain(session.prompt("Hi")); })));`,
      ]);
    try {
      const children = [child(), child()];
      const exits = await Promise.all(children.map((process) => process.exited));
      if (exits.some((code) => code !== 0)) {
        for (const failed of children) console.error(await new Response(failed.stderr).text());
      }
      expect(exits).toEqual([0, 0]);
      expect(refreshes).toEqual(["shared-refresh"]);
      expect(JSON.parse(await readFile(join(configDirectory, "auth.json"), "utf8"))).toMatchObject({
        "openai-codex": {
          access: jwt("race-account"),
          refresh: "race-refresh",
          accountId: "race-account",
        },
      });
    } finally {
      void server.stop(true);
      void tokenServer.stop(true);
    }
  }, 15_000);
});
