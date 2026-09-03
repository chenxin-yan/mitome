import { describe, expect, it } from "@effect/vitest";
import { Cause, ConfigProvider, Effect, Exit, Schema, Stream } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import { createSession, credentialDescriptor } from "@mitome/core";
import { agent, sse } from "../support.js";
import { knownModelIds, openaiCompatible } from "../../src/openai-compatible/index.js";

type Json = typeof Schema.Json.Type;
type JsonObject = { readonly [key: string]: Json };
interface ToolMessage {
  readonly role: string;
  readonly tool_call_id?: string;
  readonly content?: Json;
}
interface FollowUpRequest {
  readonly messages?: ReadonlyArray<ToolMessage>;
}

const key = "MITOME_OPENAI_COMPATIBLE_TEST_KEY";
const fakeFetch =
  (handle: (request: Request) => Response | Promise<Response>): typeof globalThis.fetch =>
  async (input, init) =>
    handle(new Request(input, init));
const run = <A, E>(
  effect: Effect.Effect<A, E>,
  fetch: typeof globalThis.fetch = globalThis.fetch,
  config: Record<string, string> = { [key]: "synthetic-key" },
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(config)),
    ),
  );
const chunk = (delta: JsonObject, finishReason: string | null = null) => ({
  id: "chatcmpl-test",
  model: "gpt-4o-mini",
  created: 1,
  choices: [{ index: 0, finish_reason: finishReason, delta }],
});

describe("openaiCompatible", () => {
  it("exports an intentionally empty Model catalog", () => {
    expect(knownModelIds).toEqual([]);
  });

  it("exposes its credential descriptor without building a Session", () => {
    expect(
      credentialDescriptor(
        openaiCompatible({
          id: "compatible",
          baseUrl: "http://localhost:1",
          apiKeyEnv: "MITOME_TEST_API_KEY",
        }),
      ),
    ).toBe("MITOME_TEST_API_KEY");
    expect(
      credentialDescriptor(openaiCompatible({ id: "local", baseUrl: "http://localhost:1" })),
    ).toBeUndefined();
  });

  it("passes known and arbitrary model ids unchanged and streams text incrementally", async () => {
    const requests: Array<{
      readonly model: string;
      readonly stream: boolean;
      readonly authorization: string | null;
    }> = [];
    let releaseSecond!: () => void;
    const secondReleased = new Promise<void>((resolve) => (releaseSecond = resolve));
    let firstChunk!: () => void;
    const firstChunkSent = new Promise<void>((resolve) => (firstChunk = resolve));
    const fetch = fakeFetch(async (request) => {
      expect(new URL(request.url).pathname).toBe("/v1/chat/completions");
      // SAFETY: this controlled client request is emitted from the compatible request schema.
      const body = (await request.json()) as { model: string; stream: boolean };
      requests.push({
        model: body.model,
        stream: body.stream,
        authorization: request.headers.get("authorization"),
      });
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            const enqueue = (value: string) => controller.enqueue(new TextEncoder().encode(value));
            enqueue(sse(chunk({ content: "hel" })));
            firstChunk();
            await secondReleased;
            enqueue(sse(chunk({ content: "lo" }, "stop")));
            enqueue(sse("[DONE]"));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });

    const provider = openaiCompatible({
      id: "compatible",
      apiKeyEnv: key,
      // Trailing slash pins baseUrl normalization.
      baseUrl: "https://test.invalid/v1/",
    });
    const events: Array<unknown> = [];
    let firstOutput!: () => void;
    const output = new Promise<void>((resolve) => (firstOutput = resolve));
    const turn = run(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* createSession(agent(provider, "gpt-4o-mini"));
          yield* Stream.runForEach(session.runTurn("Hi"), (event) =>
            Effect.sync(() => {
              events.push(event);
              if (event.type === "model-output") firstOutput();
            }),
          );
        }),
      ),
      fetch,
    );
    await firstChunkSent;
    await output;
    expect(events).toEqual([{ type: "model-output", text: "hel" }]);
    releaseSecond();
    await turn;
    expect(events).toEqual([
      { type: "model-output", text: "hel" },
      { type: "model-output", text: "lo" },
      expect.objectContaining({ type: "response-complete", finishReason: "stop" }),
    ]);

    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* createSession(agent(provider, "ft:private-model"));
          yield* Stream.runDrain(session.runTurn("Hi"));
        }),
      ),
      fetch,
    );
    expect(requests).toEqual([
      { model: "gpt-4o-mini", stream: true, authorization: "Bearer synthetic-key" },
      { model: "ft:private-model", stream: true, authorization: "Bearer synthetic-key" },
    ]);
  });

  it("fails first use when its environment credential is missing", async () => {
    const provider = openaiCompatible({
      id: "compatible",
      apiKeyEnv: key,
      baseUrl: "http://127.0.0.1/v1",
    });
    await expect(
      run(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* createSession(agent(provider, "gpt-4o-mini"));
            yield* Stream.runDrain(session.runTurn("Hi"));
          }),
        ),
        globalThis.fetch,
        {},
      ),
    ).rejects.toMatchObject({
      _tag: "TurnError",
      message: `Environment variable ${key} is not set or empty`,
    });
  });

  it("surfaces backend model rejection after the request without preflight", async () => {
    let requests = 0;
    const fetch = fakeFetch(async () => {
      requests += 1;
      return Response.json({ error: { message: "model not found" } }, { status: 404 });
    });
    const provider = openaiCompatible({
      id: "compatible",
      apiKeyEnv: key,
      baseUrl: "https://test.invalid/v1",
    });
    const exit = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* createSession(agent(provider, "future-private-model"));
          return yield* Effect.exit(Stream.runDrain(session.runTurn("Hi")));
        }),
      ),
      fetch,
    );
    expect(Cause.squash(Exit.isFailure(exit) ? exit.cause : Cause.empty)).toMatchObject({
      _tag: "TurnError",
      cause: { reason: { _tag: "InvalidRequestError" } },
    });
    expect(requests).toBe(1);
  });

  it("maps tool calls through the Core Tool loop", async () => {
    let calls = 0;
    let followUp: FollowUpRequest = {};
    const fetch = fakeFetch(async (request) => {
      // SAFETY: this controlled client request is emitted from the compatible request schema.
      const body = (await request.json()) as {
        readonly tools?: ReadonlyArray<Json>;
        readonly messages?: ReadonlyArray<ToolMessage>;
      };
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
      followUp = body;
      return new Response(sse(chunk({ content: "done" }, "stop")) + sse("[DONE]"), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const echo = Tool.make("echo", {
      parameters: Schema.Struct({ text: Schema.String }),
      success: Schema.String,
    });
    const provider = openaiCompatible({
      id: "compatible",
      apiKeyEnv: key,
      baseUrl: "https://test.invalid/v1",
    });
    const definition = agent(provider, "gpt-4o-mini", [
      {
        name: "echo",
        toolkit: Toolkit.make(echo),
        handlers: {
          // SAFETY: Toolkit validates handler parameters with the echo schema.
          echo: (params) => Effect.succeed((params as { text: string }).text),
        },
      },
    ]);
    const events = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* createSession(definition);
          return yield* Stream.runCollect(session.runTurn("Hi"));
        }),
      ),
      fetch,
    );
    expect([...events]).toEqual([
      { type: "tool-call", id: "call-1", name: "echo", params: { text: "hello" } },
      { type: "tool-result", id: "call-1", name: "echo", result: "hello", isFailure: false },
      { type: "model-output", text: "done" },
      expect.objectContaining({ type: "response-complete", finishReason: "stop" }),
    ]);
    expect(calls).toBe(2);
    // The follow-up request must carry the tool result attributed to the original call.
    const toolMessage = followUp.messages?.find((message) => message.role === "tool");
    expect(toolMessage).toMatchObject({ tool_call_id: "call-1" });
    expect(JSON.stringify(toolMessage?.content)).toContain("hello");
  });
});
