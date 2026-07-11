import { Cause, Effect, Exit, Stream } from "effect";
import { createSession } from "@mitome/core";
import type { Definition, TurnEvent } from "@mitome/core";

export type { Definition, Model, Plugin, TurnEvent } from "@mitome/core";

export interface Session {
  readonly prompt: (text: string) => AsyncIterable<TurnEvent>;
}

export const defineAgent = (definition: Definition): Definition => definition;

class CallbackFailure {
  constructor(readonly cause: unknown) {}
}

export const withSession = <A>(
  definition: Definition,
  use: (session: Session) => Promise<A>,
): Promise<A> =>
  Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* createSession(definition);
        return yield* Effect.tryPromise({
          try: () => use({ prompt: (text) => Stream.toAsyncIterable(session.prompt(text)) }),
          catch: (error) => new CallbackFailure(error),
        });
      }),
    ),
  ).then((exit) => {
    if (Exit.isSuccess(exit)) {
      return exit.value;
    }

    const failure = Cause.squash(exit.cause);
    if (failure instanceof CallbackFailure) {
      throw failure.cause;
    }
    throw failure;
  });
