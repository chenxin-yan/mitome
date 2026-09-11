import { Effect, Schema } from "effect";
import { TurnEventDtoSchema, type TurnEventDto } from "./session/events.js";
import type { Transcript, TranscriptId } from "./transcript.js";

/** Schema of one `TranscriptStore.list` row. */
export const TranscriptSummarySchema = Schema.Struct({
  id: Schema.String,
  parentTranscriptId: Schema.optional(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  messageCount: Schema.Natural,
  preview: Schema.String,
});
/**
 * One row of `TranscriptStore.list`: id, lineage, ISO timestamps, message count, and a single-line
 * preview of the first user Message.
 */
export type TranscriptSummary = typeof TranscriptSummarySchema.Type;

/** The `version` written into every event record this version of Mitome produces. */
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
/** One appended Turn event, ordered by `seq` within the Session that produced it. */
export interface TranscriptEventRecord {
  readonly transcriptId: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly version: typeof TranscriptEventRecordVersion;
  readonly event: TurnEventDto;
}

/** A Transcript store operation failed; the Turn that triggered it fails and stays uncommitted. */
export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** No Transcript exists for the requested id. */
export class TranscriptNotFound extends Schema.TaggedError<TranscriptNotFound>()(
  "TranscriptNotFound",
  { id: Schema.String },
) {}

/**
 * Effect-native persistence contract. Sessions call `save` and `appendEvent`; Hosts call `load` and
 * `list` to resume. Adapters own their concurrency policy: concurrent resumes are independent forks.
 */
export interface TranscriptStore {
  /** Persists the snapshot of a Transcript after a Turn completed. */
  readonly save: (transcript: Transcript) => Effect.Effect<void, StoreError>;
  /** Loads a Transcript to seed a new Session. */
  readonly load: (id: TranscriptId) => Effect.Effect<Transcript, StoreError | TranscriptNotFound>;
  /** Lists stored Transcripts for pickers and resume. */
  readonly list: () => Effect.Effect<ReadonlyArray<TranscriptSummary>, StoreError>;
  /** Appends one Turn event record: write-only observability data that is never replayed. */
  readonly appendEvent: (record: TranscriptEventRecord) => Effect.Effect<void, StoreError>;
}

interface StoredTranscript {
  readonly transcript: Transcript;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Derives the `messageCount` and `preview` fields of a `TranscriptSummary` from a Transcript. */
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

/**
 * In-memory store for tests or a shared store without disk writes. Contents live as long as the
 * returned value; event records are discarded.
 */
export const memoryTranscripts = (): TranscriptStore => {
  const transcripts = new Map<TranscriptId, StoredTranscript>();

  return {
    save: (transcript) =>
      Effect.sync(() => {
        const now = new Date().toISOString();
        const previous = transcripts.get(transcript.id);
        transcripts.set(transcript.id, {
          transcript,
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
        });
      }),
    load: (id) =>
      Effect.suspend(() => {
        const stored = transcripts.get(id);
        return stored === undefined
          ? Effect.fail(new TranscriptNotFound({ id }))
          : Effect.succeed(stored.transcript);
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
    appendEvent: () => Effect.void,
  };
};
