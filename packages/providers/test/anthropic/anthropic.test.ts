import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema, Stream } from "effect";
import { LanguageModel, type Response as AiResponse, Tool, Toolkit } from "effect/ai";
import { Provider } from "@mitome/core";
import { fakeFetch, runWithKey, sse } from "../support.js";
import { anthropic } from "../../src/anthropic/index.js";

const key = "MITOME_ANTHROPIC_TEST_KEY";
const run = runWithKey(key);

const message = (content: ReadonlyArray<unknown>) => ({
  id: "msg-1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-6",
  content,
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    cache_creation: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    service_tier: "standard",
  },
});

interface SentBody {
  readonly tools?: ReadonlyArray<{ readonly strict?: boolean }>;
}

/** Answers every request with `text` and records each parsed request body. */
const capture = (text: string) => {
  const bodies: Array<SentBody> = [];
  const fetch = fakeFetch(async (request) => {
    // SAFETY: this controlled client request is emitted from the Anthropic request schema.
    bodies.push((await request.json()) as SentBody);
    return Response.json(message([{ type: "text", text }]));
  });
  return { bodies, fetch };
};

describe("anthropic", () => {
  it("exposes its credential descriptor without provisioning a Model", () => {
    expect(Provider.credentialDescriptor(anthropic())).toBe("ANTHROPIC_API_KEY");
    expect(Provider.credentialDescriptor(anthropic({ apiKeyEnv: "MITOME_TEST_API_KEY" }))).toBe(
      "MITOME_TEST_API_KEY",
    );
  });

  it("passes model ids unchanged and streams Messages API output", async () => {
    const requests: Array<{
      readonly path: string;
      readonly model: string;
      readonly maxTokens: number;
      readonly stream: boolean;
      readonly apiKey: string | null;
      readonly version: string | null;
    }> = [];
    const fetch = fakeFetch(async (request) => {
      // SAFETY: this controlled client request is emitted from the Anthropic request schema.
      const body = (await request.json()) as { model: string; max_tokens: number; stream: boolean };
      requests.push({
        path: new URL(request.url).pathname,
        model: body.model,
        maxTokens: body.max_tokens,
        stream: body.stream,
        apiKey: request.headers.get("x-api-key"),
        version: request.headers.get("anthropic-version"),
      });
      const frames = [
        {
          type: "message_start",
          message: {
            id: "msg-1",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 3,
              output_tokens: 1,
              cache_creation: null,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: null,
              service_tier: "standard",
            },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hel" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: {
            input_tokens: null,
            output_tokens: 2,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
          },
        },
        { type: "message_stop" },
      ];
      return new Response(frames.map(sse).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    });

    const provider = anthropic({ apiKeyEnv: key, baseUrl: "https://test.invalid/" });
    const parts = await run(
      Stream.runCollect(LanguageModel.streamText({ prompt: "Hi" })).pipe(
        Effect.provide(Provider.model(provider, "claude-unlisted-test-model")),
      ),
      fetch,
    );
    const textDeltas = (all: ReadonlyArray<AiResponse.AnyPart>) =>
      all.flatMap((part) => (part.type === "text-delta" ? [part.delta] : []));
    expect(textDeltas([...parts])).toEqual(["hel", "lo"]);
    expect([...parts].at(-1)).toMatchObject({
      type: "finish",
      reason: "stop",
      usage: { inputTokens: { total: 3 }, outputTokens: { total: 2 } },
    });
    expect(requests).toEqual([
      {
        path: "/v1/messages",
        model: "claude-unlisted-test-model",
        maxTokens: expect.any(Number),
        stream: true,
        apiKey: "synthetic-key",
        version: "2023-06-01",
      },
    ]);
    expect(Number.isInteger(requests[0]?.maxTokens)).toBe(true);
    expect(requests[0]?.maxTokens).toBeGreaterThan(0);
  });

  it("decodes Anthropic's simplest documented stream, which omits optional usage fields", async () => {
    // The basic streaming example of Anthropic's streaming documentation, byte for byte.
    const documented = [
      'event: message_start\ndata: {"type": "message_start", "message": {"id": "msg_1nZdL29xx5MUA1yADyHTEsnR8uuvGzszyY", "type": "message", "role": "assistant", "content": [], "model": "claude-opus-4-6", "stop_reason": null, "stop_sequence": null, "usage": {"input_tokens": 25, "output_tokens": 1}}}',
      'event: content_block_start\ndata: {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}',
      'event: ping\ndata: {"type": "ping"}',
      'event: content_block_delta\ndata: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hello"}}',
      'event: content_block_delta\ndata: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "!"}}',
      'event: content_block_stop\ndata: {"type": "content_block_stop", "index": 0}',
      'event: message_delta\ndata: {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence":null}, "usage": {"output_tokens": 15}}',
      'event: message_stop\ndata: {"type": "message_stop"}',
    ];
    const fetch = fakeFetch(
      () =>
        new Response(documented.map((event) => `${event}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const parts = await run(
      Stream.runCollect(LanguageModel.streamText({ prompt: "Hello" })).pipe(
        Effect.provide(Provider.model(anthropic({ apiKeyEnv: key }), "claude-opus-4-6")),
      ),
      fetch,
    );
    expect([...parts].flatMap((part) => (part.type === "text-delta" ? [part.delta] : []))).toEqual([
      "Hello",
      "!",
    ]);
    expect([...parts].at(-1)).toMatchObject({
      type: "finish",
      reason: "stop",
      usage: { inputTokens: { total: 25 }, outputTokens: { total: 15 } },
    });
  });

  // Anthropic accepts at most 20 strict Tools per request.
  it("sends more than 20 ordinary Tools without marking them strict", async () => {
    const tools = Array.from({ length: 21 }, (_, index) =>
      Tool.make(`tool${index}`, { parameters: Schema.Struct({ key: Schema.String }) }),
    );
    const { bodies, fetch } = capture("done");
    await run(
      LanguageModel.generateText({
        prompt: "Hi",
        toolkit: Toolkit.make(...tools),
        disableToolCallResolution: true,
      }).pipe(
        Effect.provide(
          Provider.model(
            anthropic({ apiKeyEnv: key, baseUrl: "https://test.invalid" }),
            "claude-sonnet-4-6",
          ),
        ),
      ),
      fetch,
    );
    const sent = bodies[0]?.tools ?? [];
    expect(sent).toHaveLength(21);
    expect(sent.filter((tool) => tool.strict === true)).toEqual([]);
  });

  it("asks a capable Model for a native JSON output format in generateObject", async () => {
    const { bodies, fetch } = capture('{"answer":"yes"}');
    const result = await run(
      LanguageModel.generateObject({
        prompt: "Hi",
        schema: Schema.Struct({ answer: Schema.String }),
      }).pipe(
        Effect.provide(
          Provider.model(
            anthropic({ apiKeyEnv: key, baseUrl: "https://test.invalid" }),
            "claude-sonnet-4-6",
          ),
        ),
      ),
      fetch,
    );
    expect(result.value).toEqual({ answer: "yes" });
    expect(bodies[0]).toMatchObject({ output_config: { format: { type: "json_schema" } } });
    expect(bodies[0]).not.toHaveProperty("tools");
    expect(bodies[0]).not.toHaveProperty("tool_choice");
  });

  it("fails first use when its environment credential is missing", async () => {
    const previous = process.env[key];
    delete process.env[key];
    let requests = 0;
    const fetch = fakeFetch(() => {
      requests += 1;
      throw new Error("a missing credential must not reach the network");
    });
    try {
      const provider = anthropic({ apiKeyEnv: key });
      const error = await run(
        Effect.flip(
          LanguageModel.generateText({ prompt: "Hi" }).pipe(
            Effect.provide(Provider.model(provider, "claude-sonnet-4-6")),
          ),
        ),
        fetch,
        {},
      );
      expect(error).toMatchObject({
        _tag: "MissingCredentialError",
        message: `Environment variable ${key} is not set or empty`,
      });
      expect(requests).toBe(0);
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });
});
