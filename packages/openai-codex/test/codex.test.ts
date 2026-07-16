// Bun
// Bun's async matchers are typed void but must be awaited to stay within the test.
// oxlint-disable typescript/await-thenable
import { afterAll, describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Schema, Stream } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSession, type Definition } from "@mitome/core";
import { codex, writeCredential } from "../src/index.js";

const directories: Array<string> = [];
const jwt = (accountId: string) =>
  `header.${Buffer.from(JSON.stringify({ chatgpt_account_id: accountId })).toString("base64url")}.signature`;
const sse = (data: unknown) =>
  `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;

const directory = async () => {
  const value = await mkdtemp(join(tmpdir(), "mitome-codex-sse-"));
  directories.push(value);
  return value;
};

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

const definition = (model: ReturnType<typeof codex>): Definition => ({
  instructions: "Be concise.",
  model,
  plugins: [],
});

const run = (model: ReturnType<typeof codex>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* createSession(definition(model));
        return yield* Stream.runCollect(session.prompt("Hi"));
      }),
    ),
  );

afterAll(async () => {
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

describe("Codex SSE", () => {
  test("sends the documented SSE request and streams text incrementally", async () => {
    const configDirectory = await directory();
    await writeCredential(configDirectory, "openai-codex", credential());
    const requests: Array<{ pathname: string; headers: Headers; body: Record<string, unknown> }> =
      [];
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let firstChunk!: () => void;
    const firstSent = new Promise<void>((resolve) => (firstChunk = resolve));
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requests.push({
          pathname: new URL(request.url).pathname,
          headers: request.headers,
          body: (await request.json()) as Record<string, unknown>,
        });
        // Mirrors the real backend: message events carry both item_id and
        // output_index (output_item.added has no top-level item_id), and the
        // stream is padded with lifecycle noise events plus a trailing [DONE].
        const added = sse({
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", id: "msg-1" },
        });
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(sse({ type: "response.created", response: {} }));
              controller.enqueue(sse({ type: "response.in_progress", response: {} }));
              controller.enqueue(added.slice(0, 17));
              controller.enqueue(added.slice(17));
              controller.enqueue(
                sse({
                  type: "response.content_part.added",
                  item_id: "msg-1",
                  output_index: 0,
                }),
              );
              controller.enqueue(
                sse({
                  type: "response.output_text.delta",
                  item_id: "msg-1",
                  output_index: 0,
                  delta: "hel",
                }),
              );
              firstChunk();
              await released;
              controller.enqueue(
                sse({
                  type: "response.output_text.delta",
                  item_id: "msg-1",
                  output_index: 0,
                  delta: "lo",
                }),
              );
              controller.enqueue(
                sse({
                  type: "response.output_text.done",
                  item_id: "msg-1",
                  output_index: 0,
                  text: "hello",
                }),
              );
              controller.enqueue(
                sse({
                  type: "response.output_item.done",
                  item_id: "msg-1",
                  output_index: 0,
                  item: { type: "message", id: "msg-1" },
                }),
              );
              controller.enqueue(
                sse({ type: "response.completed", response: { status: "completed" } }),
              );
              controller.enqueue(sse("[DONE]"));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    try {
      const model = codex("future-private-model", undefined, {
        configDirectory,
        baseUrl: `http://127.0.0.1:${server.port}`,
        sessionId: "fixture-session",
      });
      const events: Array<unknown> = [];
      let firstOutput!: () => void;
      const output = new Promise<void>((resolve) => (firstOutput = resolve));
      const turn = Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* createSession(definition(model));
            yield* Stream.runForEach(session.prompt("Hi"), (event) =>
              Effect.sync(() => {
                events.push(event);
                if (event.type === "model-output") firstOutput();
              }),
            );
          }),
        ),
      );
      await firstSent;
      await output;
      expect(events).toEqual([{ type: "model-output", text: "hel" }]);
      release();
      await turn;
      expect(events).toEqual([
        { type: "model-output", text: "hel" },
        { type: "model-output", text: "lo" },
        { type: "response-complete" },
      ]);
      expect(requests).toHaveLength(1);
      const request = requests[0]!;
      expect(request.pathname).toBe("/codex/responses");
      expect(request.headers.get("authorization")).toBe("Bearer synthetic-access");
      expect(request.headers.get("chatgpt-account-id")).toBe("synthetic-account");
      expect(request.headers.get("originator")).toBe("mitome");
      expect(request.headers.get("openai-beta")).toBe("responses=experimental");
      expect(request.headers.get("accept")).toBe("text/event-stream");
      expect(request.headers.get("content-type")).toBe("application/json");
      expect(request.headers.get("user-agent")).toBe(
        `mitome (${process.platform} ${process.arch})`,
      );
      expect(request.headers.get("session-id")).toBe("fixture-session");
      expect(request.headers.get("x-client-request-id")).toBe("fixture-session");
      expect(request.headers.get("session_id")).toBeNull();
      expect(request.body).toMatchObject({
        model: "future-private-model",
        store: false,
        stream: true,
        instructions: "Be concise.",
        input: [{ role: "user", content: "Hi" }],
        text: { verbosity: "low" },
        include: ["reasoning.encrypted_content"],
        prompt_cache_key: "fixture-session",
        tool_choice: "auto",
        parallel_tool_calls: true,
      });
    } finally {
      void server.stop(true);
    }
  });

  test("maps function-call SSE events through the Core Tool loop", async () => {
    const configDirectory = await directory();
    await writeCredential(configDirectory, "openai-codex", credential());
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        // The "/codex"-suffixed baseUrl must still land on /codex/responses.
        expect(new URL(request.url).pathname).toBe("/codex/responses");
        calls += 1;
        if (calls === 1) {
          return new Response(
            sse({
              type: "response.output_item.added",
              output_index: 0,
              item: { type: "function_call", id: "item-1", call_id: "call-1", name: "echo" },
            }) +
              sse({
                type: "response.function_call_arguments.delta",
                item_id: "item-1",
                delta: '{"text":',
              }) +
              sse({
                type: "response.function_call_arguments.done",
                item_id: "item-1",
                arguments: '{"text":"hello"}',
              }) +
              sse({
                type: "response.output_item.done",
                item_id: "item-1",
                item: {
                  type: "function_call",
                  id: "item-1",
                  call_id: "call-1",
                  name: "echo",
                  arguments: '{"text":"hello"}',
                },
              }) +
              sse({ type: "response.done" }),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        return new Response(
          sse({ type: "response.output_item.added", output_index: 0, item: { type: "message" } }) +
            sse({ type: "response.output_text.delta", output_index: 0, delta: "done" }) +
            sse({ type: "response.output_item.done", output_index: 0, item: { type: "message" } }) +
            sse({ type: "response.incomplete" }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    try {
      const echo = Tool.make("echo", {
        parameters: Schema.Struct({ text: Schema.String }),
        success: Schema.String,
      });
      const events = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* createSession({
              instructions: "",
              model: codex("gpt-5.4", undefined, {
                configDirectory,
                baseUrl: `http://127.0.0.1:${server.port}/codex`,
              }),
              plugins: [
                {
                  name: "echo",
                  toolkit: Toolkit.make(echo),
                  handlers: {
                    echo: (params) => Effect.succeed((params as { text: string }).text),
                  },
                },
              ],
            });
            return yield* Stream.runCollect(session.prompt("Hi"));
          }),
        ),
      );
      expect([...events]).toEqual([
        { type: "tool-call", id: "call-1", name: "echo" },
        { type: "tool-result", id: "call-1", name: "echo", result: "hello", isFailure: false },
        { type: "model-output", text: "done" },
        { type: "response-complete" },
      ]);
    } finally {
      void server.stop(true);
    }
  });

  test("fails provider errors, malformed SSE, and unterminated streams", async () => {
    const cases: Array<[body: string, description: string]> = [
      [sse({ type: "error", error: { message: "subscriber rejected" } }), "subscriber rejected"],
      [
        sse({ type: "response.failed", response: { error: { message: "model rejected" } } }),
        "model rejected",
      ],
      ["data: {bad json}\n\n", "Codex sent malformed SSE JSON"],
      [
        'data: {"type":"response.completed"}',
        "Codex stream ended before a terminal response event",
      ],
      [
        sse({ type: "response.output_item.added", output_index: 0, item: { type: "message" } }),
        "Codex stream ended before a terminal response event",
      ],
    ];
    for (const [body, description] of cases) {
      const configDirectory = await directory();
      await writeCredential(configDirectory, "openai-codex", credential());
      const server = Bun.serve({
        port: 0,
        fetch: () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
      });
      try {
        const exit = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const session = yield* createSession(
                definition(
                  codex("gpt-5.4", undefined, {
                    configDirectory,
                    baseUrl: `http://127.0.0.1:${server.port}`,
                  }),
                ),
              );
              return yield* Effect.exit(Stream.runDrain(session.prompt("Hi")));
            }),
          ),
        );
        expect(Cause.squash(Exit.isFailure(exit) ? exit.cause : Cause.empty)).toMatchObject({
          _tag: "TurnError",
          cause: { reason: { description } },
        });
      } finally {
        void server.stop(true);
      }
    }
  });

  test("passes model rejection through after one request without a catalog", async () => {
    const configDirectory = await directory();
    await writeCredential(configDirectory, "openai-codex", credential());
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        requests += 1;
        return Response.json({ error: { message: "model not found" } }, { status: 404 });
      },
    });
    try {
      const exit = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* createSession(
              definition(
                codex("future-private-model", undefined, {
                  configDirectory,
                  baseUrl: `http://127.0.0.1:${server.port}`,
                }),
              ),
            );
            return yield* Effect.exit(Stream.runDrain(session.prompt("Hi")));
          }),
        ),
      );
      expect(Cause.squash(Exit.isFailure(exit) ? exit.cause : Cause.empty)).toMatchObject({
        _tag: "TurnError",
        // The backend's rejection body must survive into the surfaced error.
        cause: { reason: { description: expect.stringContaining("model not found") } },
      });
      expect(requests).toBe(1);
    } finally {
      void server.stop(true);
    }
  });

  test("never reuses a stale rotating refresh token across processes", async () => {
    const configDirectory = await directory();
    await writeCredential(
      configDirectory,
      "openai-codex",
      credential("expired-access", "shared-refresh", 1),
    );
    const refreshes: Array<string> = [];
    // Startup barrier: both children must arrive before either may refresh,
    // guaranteeing lock contention instead of leaving it to spawn timing.
    let arrivals = 0;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => (releaseBarrier = resolve));
    const tokenServer = Bun.serve({
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === "/barrier") {
          arrivals += 1;
          if (arrivals === 2) releaseBarrier();
          await barrier;
          return new Response("go");
        }
        const refresh = (await request.formData()).get("refresh_token") as string;
        refreshes.push(refresh);
        await Bun.sleep(100);
        if (refresh !== "shared-refresh") return new Response("stale refresh", { status: 400 });
        return Response.json({
          access_token: jwt("race-account"),
          refresh_token: "race-refresh",
          expires_in: 3_600,
        });
      },
    });
    const server = Bun.serve({
      port: 0,
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
    const source = new URL("../src/index.ts", import.meta.url).href;
    const core = new URL("../node_modules/@mitome/core/dist/index.js", import.meta.url).href;
    const child = () =>
      Bun.spawn(
        [
          process.execPath,
          "-e",
          `import { Effect, Stream } from "effect"; const { createSession } = await import(${JSON.stringify(core)}); const { codex } = await import(${JSON.stringify(source)}); await fetch(${JSON.stringify(`http://127.0.0.1:${tokenServer.port}/barrier`)}); const model = codex("gpt-5.4", undefined, ${JSON.stringify({ configDirectory, baseUrl: `http://127.0.0.1:${server.port}`, tokenUrl: `http://127.0.0.1:${tokenServer.port}/oauth/token` })}); await Effect.runPromise(Effect.scoped(Effect.gen(function* () { const session = yield* createSession({ instructions: "", model, plugins: [] }); yield* Stream.runDrain(session.prompt("Hi")); })));`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
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
  }, 10_000);

  test("refreshes proactively and retries exactly once after a 401", async () => {
    const configDirectory = await directory();
    await writeCredential(
      configDirectory,
      "openai-codex",
      credential("expired-access", "rotating-refresh", 1),
    );
    const refreshes: Array<string> = [];
    const tokenServer = Bun.serve({
      port: 0,
      async fetch(request) {
        refreshes.push((await request.formData()).get("refresh_token") as string);
        return Response.json({
          access_token: jwt("refreshed-account"),
          refresh_token: "rotated-refresh",
          expires_in: 3_600,
        });
      },
    });
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        expect(new URL(request.url).pathname).toBe("/codex/responses");
        requests += 1;
        if (requests === 1) return new Response("", { status: 401 });
        expect(request.headers.get("authorization")).toBe(`Bearer ${jwt("refreshed-account")}`);
        expect(request.headers.get("chatgpt-account-id")).toBe("refreshed-account");
        return new Response(
          sse({ type: "response.output_item.added", output_index: 0, item: { type: "message" } }) +
            sse({ type: "response.output_text.delta", output_index: 0, delta: "ok" }) +
            sse({ type: "response.output_item.done", output_index: 0, item: { type: "message" } }) +
            sse({ type: "response.completed" }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    try {
      await expect(
        run(
          codex("gpt-5.4", undefined, {
            configDirectory,
            // A fully-suffixed baseUrl must be used verbatim.
            baseUrl: `http://127.0.0.1:${server.port}/codex/responses`,
            tokenUrl: `http://127.0.0.1:${tokenServer.port}/oauth/token`,
          }),
        ),
      ).resolves.toEqual([{ type: "model-output", text: "ok" }, { type: "response-complete" }]);
      expect(refreshes).toEqual(["rotating-refresh", "rotated-refresh"]);
      expect(requests).toBe(2);
      expect(JSON.parse(await readFile(join(configDirectory, "auth.json"), "utf8"))).toMatchObject({
        "openai-codex": { refresh: "rotated-refresh", accountId: "refreshed-account" },
      });
    } finally {
      void server.stop(true);
      void tokenServer.stop(true);
    }
  });

  test("fails after one refresh when the backend keeps rejecting with 401", async () => {
    const configDirectory = await directory();
    await writeCredential(configDirectory, "openai-codex", credential());
    const refreshes: Array<string> = [];
    const tokenServer = Bun.serve({
      port: 0,
      async fetch(request) {
        refreshes.push((await request.formData()).get("refresh_token") as string);
        return Response.json({
          access_token: jwt("revoked-account"),
          refresh_token: "rotated-refresh",
          expires_in: 3_600,
        });
      },
    });
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        requests += 1;
        return new Response("", { status: 401 });
      },
    });
    try {
      await expect(
        run(
          codex("gpt-5.4", undefined, {
            configDirectory,
            baseUrl: `http://127.0.0.1:${server.port}`,
            tokenUrl: `http://127.0.0.1:${tokenServer.port}/oauth/token`,
          }),
        ),
      ).rejects.toMatchObject({ _tag: "TurnError" });
      // The retried flag must bound the refresh→401 cycle to one round trip.
      expect(requests).toBe(2);
      expect(refreshes).toEqual(["synthetic-refresh"]);
    } finally {
      void server.stop(true);
      void tokenServer.stop(true);
    }
  });
});
