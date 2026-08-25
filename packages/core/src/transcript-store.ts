import { Effect, Schema } from "effect";
import { TurnEventDtoSchema } from "./session/events.js";
import type { Transcript, TranscriptId } from "./transcript.js";

export const TranscriptSummarySchema = Schema.Struct({
  id: Schema.String,
  parentTranscriptId: Schema.optional(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  messageCount: Schema.Natural,
  preview: Schema.String,
});
export type TranscriptSummary = typeof TranscriptSummarySchema.Type;

export const TranscriptEventRecordVersion = 1 as const;
/**
 * Records decode independently. A tail without `response-complete` is an expected interrupted Turn,
 * not a corrupt log; event records are observability data and have no Session replay contract.
 */
export const TranscriptEventRecordSchema = Schema.Struct({
  transcriptId: Schema.String,
  sessionId: Schema.String,
  seq: Schema.Natural,
  version: Schema.Literal(TranscriptEventRecordVersion),
  event: TurnEventDtoSchema,
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

export const summarizeTranscript = (
  transcript: Transcript,
): Pick<TranscriptSummary, "messageCount" | "preview"> => {
  const firstUserMessage = transcript.messages.find((message) => message.role === "user");
  const preview =
    firstUserMessage?.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100) ?? "";
  return { messageCount: transcript.messages.length, preview };
};

export const memoryTranscripts = (): TranscriptStore => {
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
          ...summarizeTranscript(transcript),
        })),
      ),
    appendEvent: (record) =>
      Effect.sync(() => {
        events.push(structuredClone(record));
      }),
  };
};
