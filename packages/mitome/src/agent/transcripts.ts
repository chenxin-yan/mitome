import { Context, type Effect } from "effect";
import type { TranscriptError } from "../session/errors.js";
import type { Transcript } from "../session/session.js";

/** Hands out stored conversations. */
export interface TranscriptsService {
  /**
   * A new, empty conversation. `scope` is an opaque label the Host chooses (the CLI passes its
   * working directory); `""` is the scope of a Host that does not group conversations.
   */
  readonly create: (scope: string) => Effect.Effect<Transcript, TranscriptError>;
  /** The conversation most recently written under `scope`, if any. */
  readonly latest: (scope: string) => Effect.Effect<Transcript | undefined, TranscriptError>;
  /** The conversation with this id, if it exists. */
  readonly open: (id: string) => Effect.Effect<Transcript | undefined, TranscriptError>;
}

/**
 * Where conversations are kept. A Configuration's layer provides it; without it nothing outlives a
 * Session. Read only where a Session is made: an Extension's layer cannot supply it and Agent,
 * Extension and Tool code never see it. Keyed by a stable string because the CLI and a
 * Configuration may load different copies of this package and must still find each other's.
 */
export const Transcripts = Context.Reference<TranscriptsService | undefined>("mitome/Transcripts", {
  defaultValue: () => undefined,
});
