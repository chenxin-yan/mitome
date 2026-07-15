// Bun
// Bun's async matchers are typed void but must be awaited to stay within the test.
// oxlint-disable typescript/await-thenable
import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Schema, Stream } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { createSession, type Definition } from "@mitome/core";
import { env, openai } from "../src/index.js";

const key = "MITOME_OPENAI_TEST_KEY";
const sse = (data: unknown) =>
  `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
  id: "chatcmpl-test",
  model: "gpt-4o-mini",
  created: 1,
  choices: [{ index: 0, finish_reason: finishReason, delta }],
});

const withKey = async <A>(run: () => Promise<A>): Promise<A> => {
  const previous = process.env[key];
  process.env[key] = "synthetic-key";
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
};

describe("openai", () => {
  test("passes known and arbitrary model ids unchanged and streams text incrementally", async () => {
    const requests: Array<{ readonly model: string; readonly authorization: string | null }> = [];
    let releaseSecond!: () => void;
    const secondReleased = new Promise<void>((resolve) => (releaseSecond = resolve));
    let firstChunk!: () => void;
    const firstChunkSent = new Promise<void>((resolve) => (firstChunk = resolve));
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        expect(new URL(request.url).pathname).toBe("/v1/chat/completions");
        const body = (await request.json()) as { model: string; stream: boolean };
        requests.push({ model: body.model, authorization: request.headers.get("authorization") });
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(sse(chunk({ content: "hel" })));
              firstChunk();
              await secondReleased;
              controller.enqueue(sse(chunk({ content: "lo" }, "stop")));
              controller.enqueue(sse("[DONE]"));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });

    try {
      await withKey(async () => {
        const definition = (model: string): Definition => ({
          instructions: "Be concise.",
          model: openai(model, env(key), { baseUrl: `http://127.0.0.1:${server.port}/v1` }),
          plugins: [],
        });
        const events: Array<unknown> = [];
        let firstOutput!: () => void;
        const output = new Promise<void>((resolve) => (firstOutput = resolve));
        const turn = Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const session = yield* createSession(definition("gpt-4o-mini"));
              yield* Stream.runForEach(session.prompt("Hi"), (event) =>
                Effect.sync(() => {
                  events.push(event);
                  if (event.type === "model-output") firstOutput();
                }),
              );
            }),
          ),
        );
        await firstChunkSent;
        await output;
        expect(events).toEqual([{ type: "model-output", text: "hel" }]);
        releaseSecond();
        await turn;
        expect(events).toEqual([
          { type: "model-output", text: "hel" },
          { type: "model-output", text: "lo" },
          { type: "response-complete" },
        ]);

        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const session = yield* createSession(definition("ft:private-model"));
              yield* Stream.runDrain(session.prompt("Hi"));
            }),
          ),
        );
      });
      expect(requests).toEqual([
        { model: "gpt-4o-mini", authorization: "Bearer synthetic-key" },
        { model: "ft:private-model", authorization: "Bearer synthetic-key" },
      ]);
    } finally {
      void server.stop(true);
    }
  });

  test("fails session startup when its environment credential is missing", async () => {
    const previous = process.env[key];
    delete process.env[key];
    try {
      const model = openai("gpt-4o-mini", env(key));
      await expect(
        Effect.runPromise(Effect.scoped(createSession({ instructions: "", model, plugins: [] }))),
      ).rejects.toMatchObject({
        _tag: "TurnError",
        message: `Missing environment variable ${key}`,
      });
    } finally {
      if (previous !== undefined) process.env[key] = previous;
    }
  });

  test("surfaces backend model rejection after the request without preflight", async () => {
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        requests += 1;
        return Response.json({ error: { message: "model not found" } }, { status: 404 });
      },
    });
    try {
      await withKey(async () => {
        const model = openai("future-private-model", env(key), {
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
        });
        const exit = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const session = yield* createSession({ instructions: "", model, plugins: [] });
              return yield* Effect.exit(Stream.runDrain(session.prompt("Hi")));
            }),
          ),
        );
        expect(Cause.squash(Exit.isFailure(exit) ? exit.cause : Cause.empty)).toMatchObject({
          _tag: "TurnError",
          cause: { reason: { _tag: "InvalidRequestError" } },
        });
      });
      expect(requests).toBe(1);
    } finally {
      void server.stop(true);
    }
  });

  test("maps tool calls through the Core Tool loop", async () => {
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const body = (await request.json()) as { readonly tools?: ReadonlyArray<unknown> };
        calls += 1;
        if (calls === 1) {
          expect(body.tools).toHaveLength(1);
          return new Response(
            sse(
              chunk({
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    type: "function",
                    function: { name: "echo", arguments: '{"text":' },
                  },
                ],
              }),
            ) +
              sse(
                chunk(
                  { tool_calls: [{ index: 0, function: { arguments: '"hello"}' } }] },
                  "tool_calls",
                ),
              ) +
              sse("[DONE]"),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        return new Response(sse(chunk({ content: "done" }, "stop")) + sse("[DONE]"), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    try {
      await withKey(async () => {
        const echo = Tool.make("echo", {
          parameters: Schema.Struct({ text: Schema.String }),
          success: Schema.String,
        });
        const definition: Definition = {
          instructions: "",
          model: openai("gpt-4o-mini", env(key), { baseUrl: `http://127.0.0.1:${server.port}/v1` }),
          plugins: [
            {
              name: "echo",
              toolkit: Toolkit.make(echo),
              handlers: { echo: (params) => Effect.succeed((params as { text: string }).text) },
            },
          ],
        };
        const events = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const session = yield* createSession(definition);
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
      });
      expect(calls).toBe(2);
    } finally {
      void server.stop(true);
    }
  });
});
