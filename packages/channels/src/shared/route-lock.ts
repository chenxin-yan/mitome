import type { RouteKey } from "@mitome/core";
import { Data, Effect } from "effect";

/** A Turn was requested for a Route while another Turn on the same Route is still running. */
export class RouteBusyError extends Data.TaggedError("RouteBusyError")<{
  readonly key: RouteKey;
}> {}

/** Runs `turn` unless the Route is busy; see {@link createRouteLock}. */
export type RouteLock = <A, E, R>(
  key: RouteKey,
  turn: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E | RouteBusyError, R>;

/**
 * In-memory lock that runs one Turn at a time per Route. Two Messages for the same conversation
 * that overlap would each resume the same Transcript and fork it, so the second fails at once with
 * `RouteBusyError` for the Channel to answer on its surface (an HTTP 409, a chat reply) instead of
 * waiting. The Route is released when the Turn completes, fails, or is interrupted. The lock lives
 * as long as the returned value and covers only this process.
 */
export const createRouteLock = (): RouteLock => {
  const running = new Set<string>();
  return <A, E, R>(key: RouteKey, turn: Effect.Effect<A, E, R>) =>
    Effect.suspend<A, E | RouteBusyError, R>(() => {
      const encoded = JSON.stringify([key.channel, key.principal, key.conversation]);
      if (running.has(encoded)) return Effect.fail(new RouteBusyError({ key }));
      running.add(encoded);
      return Effect.ensuring(
        turn,
        Effect.sync(() => {
          running.delete(encoded);
        }),
      );
    });
};
