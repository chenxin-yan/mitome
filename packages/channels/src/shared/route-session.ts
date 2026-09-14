import {
  createSession,
  type AgentDefinitionError,
  type ChannelHostContext,
  type RouteKey,
  type Routes,
  type Session,
  type StoreError,
  type Transcript,
  type TurnError,
} from "@mitome/core";
import { Effect, type Scope } from "effect";

/** A Session opened for one Route, with the two ways a Channel advances the Route afterwards. */
export interface RouteSession {
  readonly session: Session;
  /** Points the Route at this Session's Transcript; run when the Turn reports completion. */
  readonly advanceRoute: Effect.Effect<void, StoreError>;
  /**
   * Advances the Route only if a Turn committed since the Session opened. A `StoreError` may arrive
   * after the Transcript save succeeded, when appending the final event record failed, and the
   * Route must still follow the committed Turn.
   */
  readonly advanceRouteIfCommitted: Effect.Effect<void>;
}

const loadRouteTranscript = (
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

/**
 * Opens the Session for a Route inside the caller's Scope: resumes the Transcript the Route names,
 * or starts fresh when the Definition persists nothing, no Route was recorded, or a stale Route
 * names a Transcript that no longer loads.
 */
export const openRouteSession = (
  routes: Routes,
  context: ChannelHostContext,
  key: RouteKey,
): Effect.Effect<RouteSession, AgentDefinitionError | TurnError | StoreError, Scope.Scope> =>
  Effect.gen(function* () {
    const transcript = yield* loadRouteTranscript(routes, context, key);
    const session = yield* createSession(context.agent, {
      transcripts: context.transcripts,
      transcript,
    });
    const committedMessages = session.history().length;
    // Without a Transcript store nothing is saved, so a Route would name a Transcript that never existed.
    const advanceRoute =
      context.transcripts === undefined ? Effect.void : routes.set(key, session.transcript().id);
    return {
      session,
      advanceRoute,
      advanceRouteIfCommitted: Effect.suspend(() =>
        session.history().length > committedMessages ? Effect.ignore(advanceRoute) : Effect.void,
      ),
    };
  });
