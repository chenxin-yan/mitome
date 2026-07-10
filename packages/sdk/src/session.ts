import { Cause, Effect, Exit, Fiber, Queue, Stream } from "effect";
import { createSession } from "@mitome/core";
import type { Definition, TurnEvent } from "@mitome/core";

export interface Session {
  readonly prompt: (text: string) => AsyncIterable<TurnEvent>;
}

class CallbackFailure {
  constructor(readonly cause: unknown) {}
}

type TurnItem =
  | { readonly _tag: "Event"; readonly event: TurnEvent }
  | { readonly _tag: "Exit"; readonly exit: Exit.Exit<void, unknown> };

// beta.97's Stream.toAsyncIterable().return() only closes its Scope, never Fiber.interrupts an in-flight pull.
// This bridge makes iterator return()/throw() interrupt active model/tool work.
const toAsyncIterable = (stream: Stream.Stream<TurnEvent, unknown>): AsyncIterable<TurnEvent> => ({
  [Symbol.asyncIterator]() {
    const queue = Effect.runSync(Queue.bounded<TurnItem>(1));
    const fiber = Effect.runFork(
      Effect.exit(
        Stream.runForEach(stream, (event) => Queue.offer(queue, { _tag: "Event", event })),
      ).pipe(Effect.flatMap((exit) => Queue.offer(queue, { _tag: "Exit", exit }))),
    );
    let closed = false;
    const close = async (): Promise<void> => {
      if (!closed) {
        closed = true;
        await Effect.runPromise(Fiber.interrupt(fiber));
        // Effect.exit does not survive external interruption, so close() supplies the missing Exit sentinel.
        // A full queue may drop it safely: post-close next() short-circuits on closed.
        Queue.offerUnsafe(queue, { _tag: "Exit", exit: Exit.succeed<void>(undefined) });
      }
    };

    return {
      async next(): Promise<IteratorResult<TurnEvent>> {
        if (closed) return { done: true, value: undefined };
        const item = await Effect.runPromise(Queue.take(queue));
        if (item._tag === "Event") return { done: false, value: item.event };
        closed = true;
        if (Exit.isSuccess(item.exit)) return { done: true, value: undefined };
        throw Cause.squash(item.exit.cause);
      },
      async return(): Promise<IteratorResult<TurnEvent>> {
        await close();
        return { done: true, value: undefined };
      },
      async throw(error: unknown): Promise<IteratorResult<TurnEvent>> {
        await close();
        throw error;
      },
    };
  },
});

export const withSession = <A>(
  definition: Definition,
  use: (session: Session) => Promise<A>,
): Promise<A> =>
  Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* createSession(definition);
        return yield* Effect.tryPromise({
          try: () => use({ prompt: (text) => toAsyncIterable(session.prompt(text)) }),
          catch: (error) => new CallbackFailure(error),
        });
      }),
    ),
  ).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value;
    const failure = Cause.squash(exit.cause);
    if (failure instanceof CallbackFailure) throw failure.cause;
    throw failure;
  });
