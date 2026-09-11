import type { TurnEvent } from "@mitome/core";
import { Effect, Stream } from "effect";
import { Prompt } from "effect/unstable/ai";
import type { SessionResource } from "../../src/session-manager.js";

/** Replays one scripted event Stream per Turn; history grows exactly when response-complete is emitted, as a real Session's does. */
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
