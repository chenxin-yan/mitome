import { Effect, Schema } from "effect";
import type { Transcript, TranscriptId } from "./transcript.js";

export const TranscriptSummarySchema = Schema.Struct({
  id: Schema.String,
  parentTranscriptId: Schema.optional(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  messageCount: Schema.Natural,
});
export type TranscriptSummary = typeof TranscriptSummarySchema.Type;

export const TranscriptEventRecordVersion = 1 as const;
export const TranscriptEventRecordSchema = Schema.Struct({
  transcriptId: Schema.String,
  sessionId: Schema.String,
  seq: Schema.Natural,
  version: Schema.Literal(TranscriptEventRecordVersion),
  event: Schema.Json,
});
export type TranscriptEventRecord = typeof TranscriptEventRecordSchema.Type;

export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class TranscriptNotFound extends Schema.TaggedError<TranscriptNotFound>()(
  "TranscriptNotFound",
  { id: Schema.String },
) {}

export interface TranscriptStore {
  readonly save: (transcript: Transcript) => Effect.Effect<void, StoreError>;
  readonly load: (id: TranscriptId) => Effect.Effect<Transcript, StoreError | TranscriptNotFound>;
  readonly list: () => Effect.Effect<ReadonlyArray<TranscriptSummary>, StoreError>;
  readonly appendEvent: (record: TranscriptEventRecord) => Effect.Effect<void, StoreError>;
}

interface StoredTranscript {
  readonly transcript: Transcript;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const makeMemoryTranscriptStore = (): TranscriptStore => {
  const transcripts = new Map<TranscriptId, StoredTranscript>();
  const events: Array<TranscriptEventRecord> = [];

  return {
    save: (transcript) =>
      Effect.sync(() => {
        const now = new Date().toISOString();
        const previous = transcripts.get(transcript.id);
        transcripts.set(transcript.id, {
          transcript: structuredClone(transcript),
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
        });
      }),
    load: (id) =>
      Effect.suspend(() => {
        const stored = transcripts.get(id);
        return stored === undefined
          ? Effect.fail(new TranscriptNotFound({ id }))
          : Effect.succeed(structuredClone(stored.transcript));
      }),
    list: () =>
      Effect.sync(() =>
        Array.from(transcripts.values(), ({ transcript, createdAt, updatedAt }) => ({
          id: transcript.id,
          parentTranscriptId: transcript.parentTranscriptId,
          createdAt,
          updatedAt,
          messageCount: transcript.messages.length,
        })),
      ),
    appendEvent: (record) =>
      Effect.sync(() => {
        events.push(structuredClone(record));
      }),
  };
};
