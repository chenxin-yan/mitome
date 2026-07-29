import { Cause, Effect, Exit, Scope, Stream } from "effect";
import { createSession } from "@mitome/core";
import type {
  AgentDefinition,
  AnyProvider,
  PromptOptions,
  TurnEvent as CoreTurnEvent,
} from "@mitome/core";

type CoreApproval = Extract<CoreTurnEvent, { type: "approval-required" }>;
export type TurnEvent =
  | Exclude<CoreTurnEvent, CoreApproval>
  | (Omit<CoreApproval, "approve" | "deny"> & {
      readonly approve: () => Promise<void>;
      readonly deny: (reason?: string) => Promise<void>;
    });

export interface Session<
  Providers extends ReadonlyArray<AnyProvider> = ReadonlyArray<AnyProvider>,
> {
  /** Treat the returned iterable as single-use; requesting another iterator re-runs the Turn. */
  readonly prompt: (text: string, options?: PromptOptions<Providers>) => AsyncIterable<TurnEvent>;
}

class CallbackFailure {
  constructor(readonly cause: unknown) {}
}

const toSdkEvent = (event: CoreTurnEvent): TurnEvent => {
  if (event.type !== "approval-required") return event;
  return {
    ...event,
    approve: () => Effect.runPromise(event.approve()),
    deny: (reason) => Effect.runPromise(event.deny(reason)),
  };
};

// Stream.toAsyncIterable (effect#6595) is strictly pull-per-next: the turn
// would only progress while the consumer awaits next(). SDK turns must keep
// executing while the consumer processes the previous event (tool handlers
// start without another pull) and be interrupted as a whole on early exit.
// The ReadableStream bridge provides both: the producer runs in one forked
// fiber with one-event readahead, and cancellation interrupts it. The scope
// finalizer covers iterators abandoned without return().
const toAsyncIterable = (
  stream: Stream.Stream<CoreTurnEvent, unknown>,
  scope: Scope.Scope,
): AsyncIterable<TurnEvent> => ({
  [Symbol.asyncIterator]() {
    const reader = Stream.toReadableStream(stream).getReader();
    const cancel = () => reader.cancel().catch(() => undefined);
    Effect.runSync(Scope.addFinalizer(scope, Effect.promise(cancel)));
    let done = false;
    return {
      async next(): Promise<IteratorResult<TurnEvent>> {
        if (done) return { done: true, value: undefined };
        try {
          const result = await reader.read();
          if (result.done) {
            done = true;
            return { done: true, value: undefined };
          }
          return { done: false, value: toSdkEvent(result.value) };
        } catch (error) {
          done = true;
          throw error;
        }
      },
      async return(): Promise<IteratorResult<TurnEvent>> {
        done = true;
        await cancel();
        return { done: true, value: undefined };
      },
      async throw(error: unknown): Promise<IteratorResult<TurnEvent>> {
        done = true;
        await cancel();
        throw error;
      },
    };
  },
});

export const withSession = <const Definition extends AgentDefinition, A>(
  definition: Definition,
  use: (session: Session<Definition["providers"]>) => Promise<A>,
): Promise<A> =>
  Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* createSession(definition);
        const scope = yield* Effect.scope;
        return yield* Effect.tryPromise({
          try: () =>
            use({
              prompt: (text, options) => toAsyncIterable(session.prompt(text, options), scope),
            }),
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
