import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  makeMemoryTranscriptStore,
  makeTranscript,
  TranscriptEventRecordSchema,
  TranscriptEventRecordVersion,
  TranscriptNotFound,
  TranscriptSummarySchema,
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
          event: null,
        }),
      ).toThrow();
    }
  });
});
