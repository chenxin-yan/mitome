import { Effect } from "effect";
import {
  StoreError,
  TranscriptNotFound,
  fileTranscripts as coreFileTranscripts,
  memoryTranscripts as coreMemoryTranscripts,
} from "@mitome/core";
import type {
  Transcript,
  TranscriptEventRecord,
  TranscriptId,
  TranscriptStore as CoreTranscriptStore,
  TranscriptSummary,
} from "@mitome/core";

/** Promise-first persistence contract accepted by `@mitome/sdk`. */
export interface TranscriptStore {
  readonly save: (transcript: Transcript) => Promise<void>;
  readonly load: (id: TranscriptId) => Promise<Transcript | null>;
  readonly list: () => Promise<ReadonlyArray<TranscriptSummary>>;
  readonly appendEvent: (record: TranscriptEventRecord) => Promise<void>;
}

const storeError = (cause: unknown): StoreError =>
  cause instanceof StoreError
    ? cause
    : new StoreError({ message: "Transcript store failed", cause });

const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, StoreError> =>
  Effect.tryPromise({ try: run, catch: storeError });

/** @internal Adapts the Promise-first store to Core's canonical Effect contract. */
export const toCoreTranscriptStore = (store: TranscriptStore): CoreTranscriptStore => ({
  save: (transcript) => attempt(() => store.save(transcript)),
  load: (id) =>
    attempt(() => store.load(id)).pipe(
      Effect.flatMap((transcript) =>
        transcript === null
          ? Effect.fail(new TranscriptNotFound({ id }))
          : Effect.succeed(transcript),
      ),
    ),
  list: () => attempt(() => store.list()),
  appendEvent: (record) => attempt(() => store.appendEvent(record)),
});

const fromCoreTranscriptStore = (store: CoreTranscriptStore): TranscriptStore => ({
  save: (transcript) => Effect.runPromise(store.save(transcript)),
  load: (id) =>
    Effect.runPromise(
      store.load(id).pipe(Effect.catchTag("TranscriptNotFound", () => Effect.succeed(null))),
    ),
  list: () => Effect.runPromise(store.list()),
  appendEvent: (record) => Effect.runPromise(store.appendEvent(record)),
});

export const memoryTranscripts = (): TranscriptStore =>
  fromCoreTranscriptStore(coreMemoryTranscripts());

export const fileTranscripts = (directory?: string): TranscriptStore =>
  fromCoreTranscriptStore(coreFileTranscripts(directory));
