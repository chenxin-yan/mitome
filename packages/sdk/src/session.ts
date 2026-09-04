import { Cause, Effect, Exit, Schema, Scope, Stream } from "effect";
import { Prompt as AiPrompt } from "effect/unstable/ai";
import { createSession } from "@mitome/core";
import type { FinishReason, PromptMessage, Usage } from "./models.js";
import { toCoreTranscriptStore } from "./transcript-store.js";
import type { TranscriptStore } from "./transcript-store.js";
import type {
  AgentDefinition,
  AnyProvider,
  TurnOptions,
  Transcript,
  TranscriptId,
  TurnEvent as CoreTurnEvent,
} from "@mitome/core";

type CoreApproval = Extract<CoreTurnEvent, { type: "approval-required" }>;
type CoreResponseComplete = Extract<CoreTurnEvent, { type: "response-complete" }>;
/**
 * One event from `Session.runTurn`: `model-output` and `reasoning` text, `tool-call` and
 * `tool-result` activity, `approval-required` with Promise-returning decisions, and a final
 * `response-complete`. Failures are thrown while iterating, not emitted as events.
 */
export type TurnEvent =
  | Exclude<CoreTurnEvent, CoreApproval | CoreResponseComplete>
  | (Omit<CoreApproval, "approve" | "deny"> & {
      /** Lets the Tool call run. One-shot: resolving again or after the Turn ended rejects with `ApprovalResolutionError`. */
      readonly approve: () => Promise<void>;
      /** Rejects the Tool call; the Model sees `reason`. One-shot like `approve`. */
      readonly deny: (reason?: string) => Promise<void>;
    })
  | {
      readonly type: "response-complete";
      readonly finishReason?: FinishReason | undefined;
      readonly usage?: Usage | undefined;
    };

/** The live Session handed to a `withSession` callback; it is released when the callback settles. */
export interface Session<
  Providers extends ReadonlyArray<AnyProvider> = ReadonlyArray<AnyProvider>,
> {
  /**
   * Runs one Turn for a user Message. The returned iterable is single-use; requesting a second
   * iterator throws. Returning from the iterator early interrupts the Turn, fires the Hook
   * `AbortSignal`, and leaves the Session usable; the interrupted Turn is not committed.
   */
  readonly runTurn: (message: string, options?: TurnOptions<Providers>) => AsyncIterable<TurnEvent>;
  /** The committed Model Prompt, advanced only after a Turn completes and its Transcript save succeeds. */
  readonly history: () => ReadonlyArray<PromptMessage>;
  /** Serializable snapshot of the committed Messages with this Session's Transcript id and lineage. */
  readonly transcript: () => Transcript;
}

/**
 * Persistence and seeding for `withSession`: a `transcripts` store, a `transcript` to seed from, or
 * a store plus the id to `resume`. Resuming loads that Transcript and forks a new one whose
 * `parentTranscriptId` is the seed; an unknown id rejects with `TranscriptNotFound`.
 */
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

const encodeMessages = Schema.encodeSync(Schema.Array(AiPrompt.Message));

const toSdkEvent = (event: CoreTurnEvent): TurnEvent => {
  if (event.type === "response-complete") {
    return {
      type: event.type,
      finishReason: event.finishReason,
      usage:
        event.usage === undefined
          ? undefined
          : {
              inputTokens: { ...event.usage.inputTokens },
              outputTokens: { ...event.usage.outputTokens },
            },
    };
  }
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

/**
 * Opens a Session for the Agent Definition, runs the callback, and releases the Session afterwards,
 * including on failure or interruption. Rejects with the tagged Session errors (`AgentDefinitionError`,
 * `TurnError`, `StoreError`, ...); errors thrown by the callback are rethrown unchanged.
 */
export function withSession<const Definition extends AgentDefinition, A>(
  definition: Definition,
  use: (session: Session<Definition["providers"]>) => Promise<A>,
): Promise<A>;
/** Opens a Session with persistence or seeding options; see `SessionOptions`. */
export function withSession<const Definition extends AgentDefinition, A>(
  definition: Definition,
  options: SessionOptions,
  use: (session: Session<Definition["providers"]>) => Promise<A>,
): Promise<A>;
export function withSession<const Definition extends AgentDefinition, A>(
  definition: Definition,
  ...args:
    | [use: (session: Session<Definition["providers"]>) => Promise<A>]
    | [options: SessionOptions, use: (session: Session<Definition["providers"]>) => Promise<A>]
): Promise<A> {
  const [options, use] = args.length === 1 ? [{}, args[0]] : args;
  const transcripts =
    options.transcripts === undefined ? undefined : toCoreTranscriptStore(options.transcripts);

  return Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const transcript =
          options.resume === undefined
            ? options.transcript
            : yield* toCoreTranscriptStore(options.transcripts).load(options.resume);
        const session = yield* createSession(definition, {
          transcripts,
          transcript,
        });
        const scope = yield* Effect.scope;
        return yield* Effect.tryPromise({
          try: () =>
            use({
              runTurn: (message, turnOptions) =>
                toAsyncIterable(session.runTurn(message, turnOptions), scope),
              history: () => encodeMessages(session.history()),
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
}
