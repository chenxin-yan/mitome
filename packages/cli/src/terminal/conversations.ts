/** The conversation the terminal is in, which `/new` replaces. */

import { Effect } from "effect";
import { userError } from "../errors.js";
import { terminalCommands } from "./keys.js";

interface Listed {
  readonly name: string;
  readonly description: string;
}

/** What the terminal needs of a Session to replace it. */
interface ReplaceableSession {
  readonly commands: ReadonlyArray<Listed & { readonly extension: string }>;
  readonly close: Effect.Effect<void>;
}

/** A Session of the terminal and what names its conversation for a person, if it is kept. */
export interface Conversation<Session> {
  readonly session: Session;
  readonly conversation: string | undefined;
}

/** Which Extension names a Command the terminal names itself, said for a person, if one does. */
export const clashing = (commands: ReplaceableSession["commands"]): string | undefined => {
  const clash = commands.find(({ name }) => terminalCommands.some((own) => own.name === name));
  return clash === undefined
    ? undefined
    : `Extension "${clash.extension}" names a Command /${clash.name}, which the terminal names itself`;
};

/**
 * Starts in `first`. `current` is the conversation in use, with every Command a person can type in
 * it, the terminal's own first; a new value means a new conversation. `newConversation` opens
 * another with `open` and switches to it only once it is open and names no Command the terminal
 * names, so a failure or an interrupt before then keeps the current one and releases the other.
 * Once switched, the replaced Session is closed without interruption.
 */
export const conversations = <Session extends ReplaceableSession>(
  first: Conversation<Session>,
  open: Effect.Effect<Conversation<Session>, unknown>,
) => {
  const listed = (opened: Conversation<Session>) => ({
    ...opened,
    commands: [...terminalCommands, ...opened.session.commands],
  });
  let current = listed(first);
  return {
    current: () => current,
    newConversation: Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const next = yield* restore(open);
        const clash = clashing(next.session.commands);
        if (clash !== undefined) {
          yield* next.session.close;
          return yield* userError(clash);
        }
        const previous = current;
        current = listed(next);
        yield* previous.session.close;
      }),
    ),
  };
};
