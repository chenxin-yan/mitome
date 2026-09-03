import { Cause, Effect, Exit, Scope, Stream } from "effect";
import { createSession } from "@mitome/core";
import type {
  AgentDefinition,
  AnyProvider,
  TurnOptions,
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
  /** The returned iterable is single-use; requesting a second iterator throws. */
  readonly runTurn: (message: string, options?: TurnOptions<Providers>) => AsyncIterable<TurnEvent>;
  readonly history: CoreSession<Providers>["history"];
  readonly transcript: CoreSession<Providers>["transcript"];
}

export type SessionOptions =
  | {
      readonly transcripts?: TranscriptStore | undefined;
      readonly transcript?: Transcript | undefined;
      readonly resume?: never;
    }
  | {
      readonly transcripts: TranscriptStore;
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
// A native async generator cannot serve here: its return() queues behind an
// in-flight next() blocked on reader.read(), so breaking out of iteration
// mid-read would deadlock. return()/throw() must cancel the reader immediately.
const toAsyncIterable = (
  stream: Stream.Stream<CoreTurnEvent, unknown>,
  scope: Scope.Scope,
): AsyncIterable<TurnEvent> => {
  // Single-use guard: a second iteration would silently re-run the paid Turn.
  let iterated = false;
  return {
    [Symbol.asyncIterator]() {
      if (iterated) {
        throw new Error(
          "session.runTurn() returns a single-use iterable; call runTurn() again to run a new Turn",
        );
      }
      iterated = true;
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
        async throw(cause: unknown): Promise<IteratorResult<TurnEvent>> {
          done = true;
          await cancel();
          throw cause;
        },
      };
    },
  };
};

export const withSession = <const Definition extends AgentDefinition, A>(
  definition: Definition,
  use: (session: Session<Definition["providers"]>) => Promise<A>,
  options: SessionOptions = {},
): Promise<A> =>
  Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const transcript =
          options.resume === undefined
            ? options.transcript
            : yield* options.transcripts.load(options.resume);
        const session = yield* createSession(definition, {
          transcripts: options.transcripts,
          transcript,
        });
        const scope = yield* Effect.scope;
        return yield* Effect.tryPromise({
          try: () =>
            use({
              runTurn: (message, turnOptions) =>
                toAsyncIterable(session.runTurn(message, turnOptions), scope),
              history: session.history,
              transcript: session.transcript,
            }),
          catch: (cause) => new CallbackFailure(cause),
        });
      }),
    ),
  ).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value;
    const failure = Cause.squash(exit.cause);
    if (failure instanceof CallbackFailure) throw failure.cause;
    throw failure;
  });
