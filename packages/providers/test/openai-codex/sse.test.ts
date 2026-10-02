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

  test("emits each indexed streamed text part once, in content order around a refusal", async () => {
    const at = { output_index: 0, item_id: "m0" };
    const parts = await decode(
      sse({
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "m0" },
      }),
      sse({ type: "response.output_text.delta", ...at, content_index: 0, delta: "A" }),
      sse({ type: "response.refusal.done", ...at, content_index: 1, refusal: "R" }),
      sse({ type: "response.output_text.delta", ...at, content_index: 2, delta: "B" }),
      sse({
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "message", id: "m0" },
      }),
      sse({ type: "response.completed" }),
    );
    // The last part is the finish; every text part starts and ends exactly once.
    expect(parts.slice(0, -1)).toMatchObject([
      { type: "text-start", id: "0~0" },
      { type: "text-delta", id: "0~0", delta: "A" },
      { type: "text-start", id: "0~2" },
      { type: "text-delta", id: "0~2", delta: "B" },
      { type: "text-end", id: "0~0" },
      { type: "text-start", id: "0~1", metadata: { openai: { refusal: "R" } } },
      { type: "text-end", id: "0~1", metadata: { openai: { refusal: "R" } } },
      { type: "text-end", id: "0~2" },
    ]);
  });

  test("streams a start's indexed text as the prefix of its deltas, once", async () => {
    const at = { output_index: 0, item_id: "m0" };
    const parts = await decode(
      sse({
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "message",
          id: "m0",
          content: [
            { type: "output_text", text: "A" },
            { type: "refusal", refusal: "R" },
          ],
        },
      }),
      sse({ type: "response.output_text.delta", ...at, content_index: 0, delta: "B" }),
      sse({ type: "response.output_text.delta", ...at, content_index: 0, delta: "C" }),
      sse({
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "message", id: "m0" },
      }),
      sse({ type: "response.completed" }),
    );
    expect(parts.slice(0, -1)).toMatchObject([
      { type: "text-start", id: "0~0" },
      { type: "text-delta", id: "0~0", delta: "A" },
      { type: "text-delta", id: "0~0", delta: "B" },
      { type: "text-delta", id: "0~0", delta: "C" },
      { type: "text-end", id: "0~0" },
      { type: "text-start", id: "0~1", metadata: { openai: { refusal: "R" } } },
      { type: "text-end", id: "0~1", metadata: { openai: { refusal: "R" } } },
    ]);
  });

  test("ends a message finished with status incomplete once, at the incomplete terminal, with its listing's refusal", async () => {
    const at = { output_index: 0, item_id: "m0" };
    const parts = await decode(
      sse({
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "m0" },
      }),
      sse({ type: "response.output_text.delta", ...at, content_index: 0, delta: "A" }),
      sse({
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "message", id: "m0", status: "incomplete" },
      }),
      sse({
        type: "response.incomplete",
        response: {
          output: [
            {
              type: "message",
              id: "m0",
              status: "incomplete",
              content: [
                { type: "output_text", text: "A" },
                { type: "refusal", refusal: "R" },
              ],
            },
          ],
        },
      }),
    );
    expect(parts.slice(0, -1)).toMatchObject([
      { type: "text-start", id: "0~0" },
      { type: "text-delta", id: "0~0", delta: "A" },
      { type: "text-end", id: "0~0" },
      { type: "text-start", id: "0~1", metadata: { openai: { refusal: "R" } } },
      { type: "text-end", id: "0~1", metadata: { openai: { refusal: "R" } } },
    ]);
    expect(parts.slice(0, -1)).toHaveLength(5);
  });

  test("streams deltas after an unfinished item as they arrive, and ends every item once, in done order", async () => {
    const m0 = { output_index: 0, item_id: "m0" };
    const m1 = { output_index: 1, item_id: "m1" };
    const parts = await decode(
      sse({ type: "response.output_item.added", ...m0, item: { type: "message", id: "m0" } }),
      sse({ type: "response.output_text.delta", ...m0, content_index: 0, delta: "A" }),
      sse({
        type: "response.output_item.done",
        ...m0,
        item: { type: "message", id: "m0", status: "incomplete" },
      }),
      sse({ type: "response.output_item.added", ...m1, item: { type: "message", id: "m1" } }),
      sse({ type: "response.output_text.delta", ...m1, content_index: 0, delta: "B" }),
      sse({ type: "response.output_item.done", ...m1, item: { type: "message", id: "m1" } }),
      sse({
        type: "response.output_item.added",
        output_index: 2,
        item: { type: "function_call", id: "item-2", call_id: "call-2", name: "lookup" },
      }),
      sse({
        type: "response.output_item.done",
        output_index: 2,
        item: { type: "function_call", id: "item-2", arguments: "{}" },
      }),
      sse({
        type: "response.incomplete",
        response: {
          output: [
            {
              type: "message",
              id: "m0",
              status: "incomplete",
              content: [
                { type: "output_text", text: "A" },
                { type: "refusal", refusal: "R" },
              ],
            },
          ],
        },
      }),
    );
    expect(parts.slice(0, -1)).toMatchObject([
      { type: "text-start", id: "0~0" },
      { type: "text-delta", id: "0~0", delta: "A" },
      { type: "text-start", id: "1~0" },
      { type: "text-delta", id: "1~0", delta: "B" },
      { type: "tool-params-start", id: "call-2" },
      { type: "text-end", id: "0~0" },
      { type: "text-start", id: "0~1", metadata: { openai: { refusal: "R" } } },
      { type: "text-end", id: "0~1", metadata: { openai: { refusal: "R" } } },
      { type: "text-end", id: "1~0" },
      { type: "tool-params-end", id: "call-2" },
      { type: "tool-call", id: "call-2", params: {} },
    ]);
    expect(parts.at(-1)).toMatchObject({ type: "finish" });
  });

  test("starts and ends no part for an unknown part of a message finished sparsely with status incomplete", async () => {
    const at = { output_index: 0, item_id: "m0" };
    const parts = await decode(
      sse({ type: "response.output_item.added", ...at, item: { type: "message", id: "m0" } }),
      sse({
        type: "response.content_part.added",
        ...at,
        content_index: 0,
        part: { type: "output_text", text: "" },
      }),
      sse({ type: "response.output_text.delta", ...at, content_index: 1, delta: "B" }),
      sse({
        type: "response.output_item.done",
        ...at,
        item: { type: "message", id: "m0", status: "incomplete" },
      }),
      sse({ type: "response.incomplete" }),
    );
    expect(parts.slice(0, -1)).toMatchObject([
      { type: "text-start", id: "0~1" },
      { type: "text-delta", id: "0~1", delta: "B" },
      { type: "text-end", id: "0~1" },
    ]);
    expect(parts.slice(0, -1)).toHaveLength(3);
  });

  test("rejects final arguments that contradict the accumulated deltas", async () => {
    await expect(
      decode(
        sse(addedCall),
        sse({
          type: "response.function_call_arguments.delta",
          output_index: 0,
          delta: '{"stale":',
        }),
        sse({
          type: "response.function_call_arguments.done",
          output_index: 0,
          arguments: '{"query":"mitome"}',
        }),
        sse(completedCall('{"query":"mitome"}')),
        sse({ type: "response.done" }),
      ),
    ).rejects.toMatchObject({
      reason: { description: "Codex sent output events that contradict each other" },
    });
  });

  test.each([
    {
      name: "emits the suffix when final arguments extend accumulated deltas",
      initial: '{"query":',
      final: '{"query":"mitome"}',
      reconciledDelta: '"mitome"}',
    },
    {
      name: "emits no reconciliation delta when final arguments repeat the complete accumulated value",
      initial: '{ "query" : "mitome" }',
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

  // An explicit response.incomplete without a reason is incomplete ("unknown"), never a
  // completion that would authorize local Tool dispatch; usage is still decoded.
  test.each([
    { name: "no response", terminal: { type: "response.incomplete" } },
    {
      name: "null details",
      terminal: { type: "response.incomplete", response: { incomplete_details: null } },
    },
    {
      name: "empty details",
      terminal: { type: "response.incomplete", response: { incomplete_details: {} } },
    },
    {
      name: "usage without details",
      terminal: {
        type: "response.incomplete",
        response: { usage: { input_tokens: 3, output_tokens: 2 } },
      },
      usage: { inputTokens: { total: 3, uncached: 3 }, outputTokens: { total: 2 } },
    },
  ])(
    "maps response.incomplete with $name to unknown, even after a Tool call",
    async ({ terminal, usage }) => {
      const finish = {
        type: "finish",
        reason: "unknown",
        usage: usage ?? { inputTokens: {}, outputTokens: {} },
      };
      expect(await decode(sse(terminal))).toMatchObject([finish]);
      const parts = await decode(sse(addedCall), sse(completedCall("{}")), sse(terminal));
      expect(parts.at(-1)).toMatchObject(finish);
    },
  );

  // A completed or done event still carries the response's own status; an explicit non-success
  // status is never read as a completion (Codex CLI keys only on the event type, see report).
  test.each(["response.completed", "response.done"])(
    "keeps an explicitly incomplete %s response incomplete, with its reason",
    async (type) => {
      const bare = { type, response: { status: "incomplete" } };
      const reasoned = {
        type,
        response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
      };
      expect(
        (await decode(sse(addedCall), sse(completedCall("{}")), sse(bare))).at(-1),
      ).toMatchObject({ type: "finish", reason: "unknown" });
      expect(await decode(sse(reasoned))).toMatchObject([{ type: "finish", reason: "length" }]);
    },
  );

  test.each([
    {
      status: "failed",
      error: { message: "backend exploded" },
      reason: { _tag: "UnknownError", description: "backend exploded" },
    },
    { status: "failed", reason: { _tag: "UnknownError", description: "Codex response failed" } },
    {
      status: "cancelled",
      reason: { _tag: "UnknownError", description: "Codex response was cancelled by the provider" },
    },
    {
      status: "cancelled",
      error: { message: "cancelled by operator" },
      reason: { _tag: "UnknownError", description: "cancelled by operator" },
    },
    {
      status: "in_progress",
      reason: {
        _tag: "InvalidOutputError",
        description: 'Codex returned a non-terminal response (status "in_progress")',
      },
    },
    {
      status: "queued",
      reason: {
        _tag: "InvalidOutputError",
        description: 'Codex returned a non-terminal response (status "queued")',
      },
    },
    {
      status: 7,
      reason: {
        _tag: "InvalidOutputError",
        description: "Codex returned an invalid response status: 7",
      },
    },
  ])(
    "fails a completed or done event whose status is $status",
    async ({ status, error, reason }) => {
      for (const type of ["response.completed", "response.done"]) {
        const terminal = { type, response: error === undefined ? { status } : { status, error } };
        const failure = await Effect.runPromise(
          Effect.flip(
            Stream.runCollect(
              decodeStream(
                Stream.fromIterable(
                  [sse(addedCall), sse(completedCall("{}")), sse(terminal)].map((chunk) =>
                    encoder.encode(chunk),
                  ),
                ),
              ),
            ),
          ),
        );
        expect(failure).toMatchObject({ _tag: "AiError", reason });
      }
    },
  );

  test("keeps completed and done terminal events without details complete", async () => {
    for (const type of ["response.completed", "response.done"]) {
      expect(await decode(sse({ type }))).toMatchObject([{ type: "finish", reason: "stop" }]);
      const parts = await decode(sse(addedCall), sse(completedCall("{}")), sse({ type }));
      expect(parts.at(-1)).toMatchObject({ type: "finish", reason: "tool-calls" });
    }
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
