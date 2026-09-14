import type { TurnEvent } from "@mitome/core";
import { Effect, Stream } from "effect";
import { Prompt } from "effect/unstable/ai";
import type { SessionResource } from "../../src/session-manager.js";

/**
 * Replays one scripted event Stream per Turn for rendering, activity, and keyboard checks.
 * History grows on `response-complete`, the success path only: a real Session also commits
 * when the Transcript save succeeds but the final event append fails, so commitment and
 * failure semantics belong in tests that drive a real Session.
 */
export const scriptedSession = (
  scripts: ReadonlyArray<Stream.Stream<TurnEvent, never>>,
): SessionResource => {
  let next = 0;
  const history: Array<Prompt.Message> = [];
  return {
    runTurn: () =>
      (scripts[next++] ?? Stream.empty).pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            if (event.type === "response-complete") {
              history.push(
                Prompt.makeMessage("user", { content: [Prompt.textPart({ text: "committed" })] }),
              );
            }
          }),
        ),
      ),
    history: () => history,
    close: Effect.void,
  };
};
