import { describe, expect, test } from "vitest";
import { Effect, Stream } from "effect";
import { decodeStream } from "../../src/openai-codex/sse.js";
import { sse } from "../support.js";

const encoder = new TextEncoder();
const decode = (...chunks: ReadonlyArray<string>) =>
  Effect.runPromise(
    Stream.runCollect(
      decodeStream(Stream.fromIterable(chunks.map((chunk) => encoder.encode(chunk)))),
    ),
  ).then(Array.from);

const addedCall = {
  type: "response.output_item.added",
  output_index: 0,
  item: { type: "function_call", id: "item-1", call_id: "call-1", name: "lookup" },
};

const completedCall = (arguments_: string) => ({
  type: "response.output_item.done",
  output_index: 0,
  item: { type: "function_call", id: "item-1", arguments: arguments_ },
});

describe("Codex SSE decoder", () => {
  test.each([
    {
      name: "malformed JSON",
      body: "data: {bad json}\n\n",
      description: "Codex sent malformed SSE JSON",
    },
    {
      name: "orphan text delta",
      body: sse({ type: "response.output_text.delta", output_index: 0, delta: "orphan" }),
      description: "Codex sent text without a message item",
    },
    {
      name: "orphan argument delta",
      body: sse({
        type: "response.function_call_arguments.delta",
        output_index: 0,
        delta: "{}",
      }),
      description: "Codex sent arguments without a Tool call",
    },
    {
      name: "missing terminal event",
      body: sse({
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message" },
      }),
      description: "Codex stream ended before a terminal response event",
    },
    {
      name: "provider error event",
      body: sse({ type: "error", error: { message: "subscriber rejected" } }),
      description: "subscriber rejected",
    },
    {
      name: "failed response event",
      body: sse({ type: "response.failed", response: { error: { message: "model rejected" } } }),
      description: "model rejected",
    },
  ])("rejects $name", async ({ body, description }) => {
    await expect(decode(body)).rejects.toMatchObject({ reason: { description } });
  });

  test.each([
    {
      name: "emits the suffix when final arguments extend accumulated deltas",
      initial: '{"query":',
      final: '{"query":"mitome"}',
      reconciledDelta: '"mitome"}',
    },
    {
      name: "emits no reconciliation delta when final arguments replace accumulated deltas",
      initial: '{"stale":',
      final: '{"query":"mitome"}',
      reconciledDelta: undefined,
    },
  ])("$name", async ({ initial, final, reconciledDelta }) => {
    const parts = await decode(
      sse(addedCall),
      sse({ type: "response.function_call_arguments.delta", output_index: 0, delta: initial }),
      sse({ type: "response.function_call_arguments.done", output_index: 0, arguments: final }),
      sse(completedCall(final)),
      sse({ type: "response.done" }),
    );

    expect(parts).toMatchObject([
      { type: "tool-params-start", id: "call-1", name: "lookup", providerExecuted: false },
      { type: "tool-params-delta", id: "call-1", delta: initial },
      ...(reconciledDelta === undefined
        ? []
        : [{ type: "tool-params-delta", id: "call-1", delta: reconciledDelta }]),
      { type: "tool-params-end", id: "call-1" },
      {
        type: "tool-call",
        id: "call-1",
        name: "lookup",
        params: { query: "mitome" },
        providerExecuted: false,
      },
      { type: "finish", reason: "tool-calls" },
    ]);
  });

  test("captures encrypted reasoning output without exposing plaintext that was not sent", async () => {
    expect(
      await decode(
        sse({
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "reasoning", id: "reasoning-1", summary: [] },
        }),
        sse({
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "reasoning",
            id: "reasoning-1",
            encrypted_content: "encrypted-reasoning",
            summary: [{ type: "summary_text", text: "Checked the repository." }],
          },
        }),
        sse({ type: "response.completed" }),
      ),
    ).toEqual([
      expect.objectContaining({ type: "reasoning-start", id: "reasoning-1:0" }),
      expect.objectContaining({
        type: "reasoning-delta",
        id: "reasoning-1:0",
        delta: "Checked the repository.",
      }),
      expect.objectContaining({
        type: "reasoning-end",
        id: "reasoning-1:0",
        metadata: {
          openai: { itemId: "reasoning-1", encryptedContent: "encrypted-reasoning" },
        },
      }),
      expect.objectContaining({ type: "finish", reason: "stop" }),
    ]);

    expect(
      await decode(
        sse({
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "reasoning",
            id: "reasoning-opaque",
            encrypted_content: "opaque-only",
            summary: [],
          },
        }),
        sse({ type: "response.completed" }),
      ),
    ).toEqual([
      expect.objectContaining({ type: "reasoning-start", id: "reasoning-opaque:0" }),
      expect.objectContaining({ type: "reasoning-end", id: "reasoning-opaque:0" }),
      expect.objectContaining({ type: "finish", reason: "stop" }),
    ]);
  });

  test.each([
    {
      name: "decodes terminal usage and maps incomplete reasons",
      terminal: {
        type: "response.incomplete",
        response: {
          incomplete_details: { reason: "max_output_tokens" },
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            input_tokens_details: { cached_tokens: 40 },
            output_tokens_details: { reasoning_tokens: 5 },
          },
        },
      },
      finish: {
        type: "finish",
        metadata: {},
        reason: "length",
        usage: {
          inputTokens: { total: 100, uncached: 60, cacheRead: 40 },
          outputTokens: { total: 20, reasoning: 5 },
        },
      },
    },
    {
      name: "emits an empty-usage finish part for a bare terminal event",
      terminal: { type: "response.completed" },
      finish: {
        type: "finish",
        metadata: {},
        reason: "stop",
        usage: { inputTokens: {}, outputTokens: {} },
      },
    },
  ])("$name", async ({ terminal, finish }) => {
    expect(await decode(sse(terminal))).toMatchObject([finish]);
  });

  test.each([
    {
      name: "prefers output_index when message events also carry item_id",
      events: [
        {
          type: "response.output_item.added",
          item_id: "msg-7",
          output_index: 7,
          item: { type: "message", id: "msg-7" },
        },
        {
          type: "response.output_text.delta",
          item_id: "msg-7",
          output_index: 7,
          delta: "hello",
        },
        {
          type: "response.output_item.done",
          item_id: "msg-7",
          output_index: 7,
          item: { type: "message", id: "msg-7" },
        },
      ],
      expected: [
        { type: "text-start", id: "7" },
        { type: "text-delta", id: "7", delta: "hello" },
        { type: "text-end", id: "7" },
        { type: "finish", reason: "stop" },
      ],
    },
    {
      name: "accepts item_id-only argument events through the Tool Call item alias",
      events: [
        {
          type: "response.output_item.added",
          output_index: 2,
          item: { type: "function_call", id: "item-2", call_id: "call-2", name: "lookup" },
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: "item-2",
          delta: '{"query":"mitome"}',
        },
        {
          type: "response.output_item.done",
          item_id: "item-2",
          item: { type: "function_call", id: "item-2", arguments: '{"query":"mitome"}' },
        },
      ],
      expected: [
        { type: "tool-params-start", id: "call-2", name: "lookup", providerExecuted: false },
        {
          type: "tool-params-delta",
          id: "call-2",
          delta: '{"query":"mitome"}',
        },
        { type: "tool-params-end", id: "call-2" },
        {
          type: "tool-call",
          id: "call-2",
          name: "lookup",
          params: { query: "mitome" },
          providerExecuted: false,
        },
        { type: "finish", reason: "tool-calls" },
      ],
    },
  ])("$name", async ({ events, expected }) => {
    expect(await decode(...events.map(sse), sse({ type: "response.completed" }))).toMatchObject(
      expected,
    );
  });
});
