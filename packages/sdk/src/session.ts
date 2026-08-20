import { Cause, Effect, Exit, Scope, Stream } from "effect";
import { createSession } from "@mitome/core";
import type {
  AgentDefinition,
  AnyProvider,
  PromptOptions,
  Session as CoreSession,
  Transcript,
  TranscriptId,
  TranscriptStore,
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
  readonly history: CoreSession<Providers>["history"];
  readonly transcript: CoreSession<Providers>["transcript"];
}

export type SessionOptions =
  | {
      readonly store?: TranscriptStore | undefined;
      readonly transcript?: Transcript | undefined;
      readonly resume?: never;
    }
  | {
      readonly store: TranscriptStore;
      readonly resume: TranscriptId;
      readonly transcript?: never;
    };

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

// Stream.toAsyncIterable is pull-per-next, but SDK turns need one-event
// readahead so work continues while the consumer processes the previous event.
// The ReadableStream bridge runs the producer in a forked fiber and cancellation
// interrupts it; the scope finalizer covers iterators abandoned without return().
const toAsyncIterable = (
  stream: Stream.Stream<CoreTurnEvent, unknown>,
  scope: Scope.Scope,
): AsyncIterable<TurnEvent> => ({
  [Symbol.asyncIterator]() {
    const reader = Stream.toReadableStream(stream).getReader();
    const cancel = () => reader.cancel().catch(() => undefined);
    if (scope.state._tag !== "Closed") {
      Effect.runSync(Scope.addFinalizer(scope, Effect.promise(cancel)));
    }
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

interface WithSession {
  <const Definition extends AgentDefinition, A>(
    definition: Definition,
    use: (session: Session<Definition["providers"]>) => Promise<A>,
  ): Promise<A>;
  <const Definition extends AgentDefinition, A>(
    definition: Definition,
    options: SessionOptions,
    use: (session: Session<Definition["providers"]>) => Promise<A>,
  ): Promise<A>;
}

export const withSession: WithSession = <const Definition extends AgentDefinition, A>(
  definition: Definition,
  optionsOrUse: SessionOptions | ((session: Session<Definition["providers"]>) => Promise<A>),
  use?: (session: Session<Definition["providers"]>) => Promise<A>,
): Promise<A> => {
  const options = typeof optionsOrUse === "function" ? {} : optionsOrUse;
  const callback = typeof optionsOrUse === "function" ? optionsOrUse : use;
  if (callback === undefined) throw new TypeError("withSession requires a callback");
  return Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const transcript =
          options.resume === undefined
            ? options.transcript
            : yield* options.store.load(options.resume);
        const session = yield* createSession(definition, { store: options.store, transcript });
        const scope = yield* Effect.scope;
        return yield* Effect.tryPromise({
          try: () =>
            callback({
              prompt: (text, promptOptions) =>
                toAsyncIterable(session.prompt(text, promptOptions), scope),
              history: session.history,
              transcript: session.transcript,
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
};
