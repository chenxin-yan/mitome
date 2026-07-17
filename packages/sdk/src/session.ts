import { Cause, Effect, Exit, Fiber, Queue, Scope, Stream } from "effect";
import { createSession } from "@mitome/core";
import type { AgentDefinition, TurnEvent as CoreTurnEvent } from "@mitome/core";

type CoreApproval = Extract<CoreTurnEvent, { type: "approval-required" }>;
export type TurnEvent =
  | Exclude<CoreTurnEvent, CoreApproval>
  | (Omit<CoreApproval, "approve" | "deny"> & {
      readonly approve: () => Promise<void>;
      readonly deny: (reason?: string) => Promise<void>;
    });

export interface Session {
  readonly prompt: (text: string) => AsyncIterable<TurnEvent>;
}

class CallbackFailure {
  constructor(readonly cause: unknown) {}
}

type TurnItem =
  | { readonly _tag: "Event"; readonly event: CoreTurnEvent }
  | { readonly _tag: "Exit"; readonly exit: Exit.Exit<void, unknown> };

const toSdkEvent = (event: CoreTurnEvent): TurnEvent => {
  if (event.type !== "approval-required") return event;
  return {
    ...event,
    approve: () => Effect.runPromise(event.approve()),
    deny: (reason) => Effect.runPromise(event.deny(reason)),
  };
};

// beta.98's Stream.toAsyncIterable().return() only closes its Scope, never Fiber.interrupts an in-flight pull.
// This bridge makes iterator return()/throw() interrupt active model/tool work.
const toAsyncIterable = (
  stream: Stream.Stream<CoreTurnEvent, unknown>,
  scope: Scope.Scope,
): AsyncIterable<TurnEvent> => ({
  [Symbol.asyncIterator]() {
    const queue = Effect.runSync(Queue.bounded<TurnItem>(1));
    const fiber = Fiber.runIn(
      Effect.runFork(
        Effect.exit(
          Stream.runForEach(stream, (event) => Queue.offer(queue, { _tag: "Event", event })),
        ).pipe(Effect.flatMap((exit) => Queue.offer(queue, { _tag: "Exit", exit }))),
      ),
      scope,
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
        if (item._tag === "Event") return { done: false, value: toSdkEvent(item.event) };
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
  definition: AgentDefinition,
  use: (session: Session) => Promise<A>,
): Promise<A> =>
  Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* createSession(definition);
        const scope = yield* Effect.scope;
        return yield* Effect.tryPromise({
          try: () => use({ prompt: (text) => toAsyncIterable(session.prompt(text), scope) }),
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
