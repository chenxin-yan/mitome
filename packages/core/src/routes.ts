import { Effect } from "effect";
import type { TranscriptId } from "./transcript.js";
import type { StoreError } from "./transcript-store.js";

/** Identifies one external conversation on a Channel. */
export interface RouteKey {
  /** The Channel Host `name` the conversation arrived through. */
  readonly channel: string;
  /** Who is talking, as the surface identifies them: a user or account id. */
  readonly principal: string;
  /** Which conversation on that surface: a chat, thread, or DM id. */
  readonly conversation: string;
}

/**
 * Effect-native Route store: maps an external conversation to its latest Transcript so the next
 * Message resumes where it left off. Every Session mints a fresh Transcript id and resume forks, so
 * a Channel advances the Route after each committed Turn. Channels receive the store through their
 * own factory options, not through `ChannelHostContext`.
 *
 * Ceiling: Transcript save and Route advance are two separate writes with no transaction across
 * them. A Channel must not report success to its surface before both have landed, and must
 * tolerate a stale pointer: a Route may name a Transcript that no longer loads, or lag one Turn
 * behind the store, in which case the Channel resumes from what it can load or starts fresh.
 */
export interface Routes {
  /** The latest Transcript for the conversation, or undefined when none has been recorded. */
  readonly get: (key: RouteKey) => Effect.Effect<TranscriptId | undefined, StoreError>;
  /** Points the conversation at a Transcript, replacing any earlier Route. */
  readonly set: (key: RouteKey, transcriptId: TranscriptId) => Effect.Effect<void, StoreError>;
  /** Forgets the conversation so its next Message starts a fresh Transcript; a no-op when absent. */
  readonly clear: (key: RouteKey) => Effect.Effect<void, StoreError>;
}

/** Canonical serialization of a key; field order is fixed so equal keys always collide. */
export const encodeRouteKey = (key: RouteKey): string =>
  JSON.stringify([key.channel, key.principal, key.conversation]);

/**
 * In-memory Route store for tests or a Channel that may forget its conversations on restart.
 * Contents live as long as the returned value.
 */
export const memoryRoutes = (): Routes => {
  const routes = new Map<string, TranscriptId>();
  return {
    get: (key) => Effect.sync(() => routes.get(encodeRouteKey(key))),
    set: (key, transcriptId) =>
      Effect.sync(() => {
        routes.set(encodeRouteKey(key), transcriptId);
      }),
    clear: (key) =>
      Effect.sync(() => {
        routes.delete(encodeRouteKey(key));
      }),
  };
};
