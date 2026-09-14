import type { ChannelHostContext, RouteKey, Routes, StoreError, Transcript } from "@mitome/core";
import { Effect } from "effect";

/**
 * The Transcript the Route points at, or undefined when the conversation starts fresh: the
 * Definition persists nothing, no Route was recorded, or a stale Route names a Transcript that no
 * longer loads.
 */
export const loadRouteTranscript = (
  routes: Routes,
  context: ChannelHostContext,
  key: RouteKey,
): Effect.Effect<Transcript | undefined, StoreError> =>
  Effect.gen(function* () {
    if (context.transcripts === undefined) return undefined;
    const transcriptId = yield* routes.get(key);
    if (transcriptId === undefined) return undefined;
    return yield* context.transcripts
      .load(transcriptId)
      .pipe(Effect.catchTag("TranscriptNotFound", () => Effect.succeed(undefined)));
  });
