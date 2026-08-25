import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Response } from "effect/unstable/ai";
import {
  makeMemoryTranscriptStore,
  makeTranscript,
  TranscriptEventRecordSchema,
  TranscriptEventRecordVersion,
  TranscriptNotFound,
  TranscriptSummarySchema,
  TurnEventDtoSchema,
} from "../src/index.js";

describe("makeMemoryTranscriptStore", () => {
  it.effect("saves, loads, and lists Transcript metadata", () =>
    Effect.gen(function* () {
      const store = makeMemoryTranscriptStore();
      const transcript = makeTranscript({ id: "transcript-1", messages: [] });

      yield* store.save(transcript);

      expect(yield* store.load(transcript.id)).toEqual(transcript);
      expect(yield* store.list()).toEqual([
        {
          id: "transcript-1",
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
          messageCount: 0,
        },
      ]);
    }),
  );

  it.effect("retains creation metadata when replacing a Transcript", () =>
    Effect.gen(function* () {
      const store = makeMemoryTranscriptStore();
      const first = makeTranscript({ id: "child", parentTranscriptId: "parent", messages: [] });
      yield* store.save(first);
      const [before] = yield* store.list();

      yield* store.save(first);
      const [after] = yield* store.list();

      expect(after).toMatchObject({
        parentTranscriptId: "parent",
        createdAt: before!.createdAt,
      });
    }),
  );

  it.effect("fails a missing load with TranscriptNotFound", () =>
    Effect.gen(function* () {
      const store = makeMemoryTranscriptStore();
      const error = yield* Effect.flip(store.load("missing"));

      expect(error).toEqual(new TranscriptNotFound({ id: "missing" }));
    }),
  );

  it.effect("accepts versioned event envelopes without exposing a replay API", () =>
    Effect.gen(function* () {
      const store = makeMemoryTranscriptStore();

      yield* store.appendEvent({
        transcriptId: "transcript-1",
        sessionId: "session-1",
        seq: 0,
        version: TranscriptEventRecordVersion,
        event: { type: "model-output", text: "hello" },
      });
    }),
  );

  it("round-trips every audit-relevant Turn event DTO", () => {
    const events = [
      { type: "model-output", text: "hello" },
      { type: "reasoning", text: "thinking" },
      { type: "tool-call", id: "call-1", name: "search", params: { query: "mitome" } },
      {
        type: "tool-result",
        id: "call-1",
        name: "search",
        result: { hits: ["result"] },
        isFailure: false,
      },
      {
        type: "approval-required",
        approvalId: "approval-1",
        toolCallId: "call-2",
        name: "delete",
        params: { path: "/tmp/file" },
      },
      {
        type: "approval-resolved",
        approvalId: "approval-1",
        toolCallId: "call-2",
        approved: false,
        reason: "not allowed",
      },
      {
        type: "response-complete",
        finishReason: "stop",
        usage: new Response.Usage({
          inputTokens: { total: 4, cacheRead: 2 },
          outputTokens: { total: 3, reasoning: 1 },
        }),
      },
    ];
    const schema = Schema.Array(TurnEventDtoSchema);
    const encoded = Schema.encodeUnknownSync(schema)(events);
    const decoded = Schema.decodeUnknownSync(schema)(JSON.parse(JSON.stringify(encoded)));

    expect(Schema.encodeSync(schema)(decoded)).toEqual(encoded);
  });

  it("fails loudly on unknown record versions and event types", () => {
    for (const invalid of [
      {
        transcriptId: "transcript-1",
        sessionId: "session-1",
        seq: 0,
        version: 2,
        event: { type: "model-output", text: "hello" },
      },
      {
        transcriptId: "transcript-1",
        sessionId: "session-1",
        seq: 0,
        version: TranscriptEventRecordVersion,
        event: { type: "future-event" },
      },
    ]) {
      expect(() => Schema.decodeUnknownSync(TranscriptEventRecordSchema)(invalid)).toThrow();
    }
  });

  it("rejects invalid count and sequence metadata", () => {
    expect(() =>
      Schema.decodeSync(TranscriptSummarySchema)({
        id: "transcript-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        messageCount: -1,
      }),
    ).toThrow();

    for (const seq of [-1, 0.5]) {
      expect(() =>
        Schema.decodeSync(TranscriptEventRecordSchema)({
          transcriptId: "transcript-1",
          sessionId: "session-1",
          seq,
          version: TranscriptEventRecordVersion,
          event: { type: "model-output", text: "hello" },
        }),
      ).toThrow();
    }
  });
});
