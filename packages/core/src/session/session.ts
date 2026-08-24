import { Context, Effect, Layer, Scope, Stream } from "effect";
import { Prompt } from "effect/unstable/ai";
import { AgentDefinitionError, compileAgentDefinition } from "../agent.js";
import type { AgentDefinition } from "../agent.js";
import type { AnyProvider, QualifiedModelId } from "../provider.js";
import { provideExtensionHook } from "../extension.js";
import type { AnyExtension } from "../extension.js";
import { SessionBusyError, SessionReleasedError, TurnError, hookTurnError } from "./errors.js";
import { turnEventToDto } from "./events.js";
import type { PersistedTurnEvent, TurnEvent } from "./events.js";
import { beginHookPhase } from "./hooks.js";
import * as ModelResolver from "./model-resolver.js";
import * as StepRunner from "./step-runner.js";
import * as ToolExecution from "./tool-execution.js";
import * as Transcript from "../transcript.js";
import type { Transcript as TranscriptValue } from "../transcript.js";
import { TranscriptEventRecordVersion } from "../transcript-store.js";
import type { StoreError, TranscriptStore } from "../transcript-store.js";

type ProvidersOf<Definition extends AgentDefinition> =
  Definition extends AgentDefinition<infer Providers, any, any> ? Providers : never;

export interface PromptOptions<Providers extends ReadonlyArray<AnyProvider>> {
  readonly model: QualifiedModelId<Providers[number]>;
}

export interface CreateSessionOptions {
  /**
   * Seeds the Session's committed history. If it has no system message, the Agent's compiled
   * instructions are intentionally not injected.
   */
  readonly transcript?: TranscriptValue | undefined;
  readonly store?: TranscriptStore | undefined;
}

export interface Session<
  Providers extends ReadonlyArray<AnyProvider> = ReadonlyArray<AnyProvider>,
> {
  readonly prompt: (
    text: string,
    options?: PromptOptions<Providers>,
  ) => Stream.Stream<TurnEvent, SessionBusyError | SessionReleasedError | StoreError | TurnError>;
  readonly history: () => ReadonlyArray<Prompt.Message>;
  readonly transcript: () => TranscriptValue;
}

const createSessionImpl: (
  definition: AgentDefinition,
  options?: CreateSessionOptions,
) => Effect.Effect<Session, AgentDefinitionError | TurnError, Scope.Scope> = Effect.fn(
  "@mitome/core/createSession",
)(function* (definition, sessionOptions = {}) {
  const compiled = yield* compileAgentDefinition(definition);

  const sessionScope = yield* Effect.scope;
  const extensionContexts = new Map<AnyExtension, Context.Context<any>>();
  for (const extension of compiled.extensions) {
    // SAFETY: contexts are intentionally heterogeneous and indexed by their owning Extension.
    let context = Context.empty() as Context.Context<any>;
    for (const dependency of extension.dependencies ?? []) {
      if (dependency.provides !== undefined) {
        // SAFETY: topological compilation ensures every dependency context was built first.
        context = Context.merge(
          context,
          Context.pick(...dependency.provides)(extensionContexts.get(dependency)!),
        );
      }
    }
    // SAFETY: contexts are intentionally heterogeneous and narrowed by the Extension's provides keys.
    let ownContext = Context.empty() as Context.Context<any>;
    if (extension.resource !== undefined) {
      // AnyExtension erases Layer input/output types; the compiled graph restores
      // the declared dependency context before hooks and handlers run.
      // SAFETY: the compiled dependency graph supplies the erased Layer requirements.
      ownContext = (yield* Layer.build(extension.resource).pipe(
        Effect.provide(context),
        hookTurnError("Extension setup failed"),
      )) as Context.Context<any>;
      context = Context.merge(context, ownContext);
    }
    const missingProvidedServices = (extension.provides ?? []).filter(
      (service) => !ownContext.mapUnsafe.has(service.key),
    );
    const missingServiceIssues = missingProvidedServices.map(
      (service) =>
        `Extension ${extension.name} Provided Service ${service.key} is missing from its resource Layer`,
    );
    const firstMissingServiceIssue = missingServiceIssues[0];
    if (firstMissingServiceIssue !== undefined) {
      return yield* new AgentDefinitionError({
        issues: [firstMissingServiceIssue, ...missingServiceIssues.slice(1)],
      });
    }
    extensionContexts.set(extension, context);
  }
  const toolExecution = yield* ToolExecution.makeToolExecution(compiled, extensionContexts);
  const modelResolver = ModelResolver.makeModelResolver(compiled.providers, sessionScope);
  const stepRunner = StepRunner.makeStepRunner(compiled, extensionContexts, toolExecution);
  const transcriptId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const parentTranscriptId = sessionOptions.transcript?.id;
  let eventSeq = 0;
  const appendTurnEvent = (event: PersistedTurnEvent): Effect.Effect<void, StoreError> =>
    sessionOptions.store === undefined
      ? Effect.void
      : Effect.sync(() => ({
          transcriptId,
          sessionId,
          seq: eventSeq,
          version: TranscriptEventRecordVersion,
          event: turnEventToDto(event),
        })).pipe(
          Effect.flatMap(sessionOptions.store.appendEvent),
          Effect.tap(() => Effect.sync(() => void eventSeq++)),
        );
  let history =
    sessionOptions.transcript === undefined
      ? Prompt.make(
          compiled.instructions === "" ? [] : [{ role: "system", content: compiled.instructions }],
        )
      : Transcript.promptFromTranscript(sessionOptions.transcript);
  let isReleased = false;
  let isTurnActive = false;

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      history = Prompt.empty;
      isReleased = true;
    }),
  );

  const sessionHooks = yield* beginHookPhase(
    compiled.extensions,
    (extension) =>
      provideExtensionHook(extension, extensionContexts, extension.hooks?.sessionStart),
    (extension) => provideExtensionHook(extension, extensionContexts, extension.hooks?.sessionEnd),
    "Session end Hook failed",
  ).pipe(hookTurnError("Session start Hook failed"));

  // A failing sessionEnd Hook must not fail scope close or skip later cleanup.
  yield* Effect.addFinalizer(() => sessionHooks.cleanup);

  return {
    prompt: (text, promptOptions) =>
      Stream.suspend<
        TurnEvent,
        SessionBusyError | SessionReleasedError | StoreError | TurnError,
        never
      >(() => {
        if (isReleased) {
          return Stream.fail(new SessionReleasedError({}));
        }
        if (isTurnActive) {
          return Stream.fail(new SessionBusyError({}));
        }
        const qualifiedModelId = promptOptions?.model ?? definition.model;
        isTurnActive = true;
        return Stream.unwrap(
          modelResolver.resolve(qualifiedModelId).pipe(
            Effect.flatMap((selected) =>
              beginHookPhase(
                compiled.extensions,
                (extension) =>
                  provideExtensionHook(
                    extension,
                    extensionContexts,
                    extension.hooks?.turnStart?.(text),
                  ),
                (extension) =>
                  provideExtensionHook(
                    extension,
                    extensionContexts,
                    extension.hooks?.turnEnd?.(text),
                  ),
                "Turn end Hook failed",
              ).pipe(
                hookTurnError("Turn start Hook failed"),
                Effect.map((turnHooks) =>
                  stepRunner.run(Prompt.concat(history, text), selected).pipe(
                    Stream.mapEffect((event) => {
                      if (event.type !== "turn-complete") return Effect.succeed(event);
                      return turnHooks.end.pipe(
                        hookTurnError("Turn end Hook failed"),
                        Effect.flatMap(() => {
                          const { type: _type, history: nextHistory, ...finish } = event;
                          // Commit the turn in-memory before persisting: a failed save surfaces
                          // StoreError without un-committing the turn, so a retry never reruns the
                          // model or turn-end hook side effects against stale history. The stored
                          // snapshot is then stale until the caller re-saves session.transcript().
                          history = nextHistory;
                          const persist =
                            sessionOptions.store === undefined
                              ? Effect.void
                              : sessionOptions.store.save(
                                  Transcript.makeTranscript({
                                    id: transcriptId,
                                    parentTranscriptId,
                                    messages: nextHistory.content,
                                  }),
                                );
                          return persist.pipe(
                            Effect.map(() => ({ type: "response-complete", ...finish }) as const),
                          );
                        }),
                      );
                    }),
                    Stream.mapEffect((event) => appendTurnEvent(event).pipe(Effect.as(event))),
                    Stream.filter(
                      (event): event is TurnEvent => event.type !== "approval-resolved",
                    ),
                    Stream.onExit(() => turnHooks.cleanup),
                  ),
                ),
              ),
            ),
          ),
        ).pipe(
          Stream.ensuring(
            Effect.sync(() => {
              toolExecution.approval.reset();
              isTurnActive = false;
            }),
          ),
        );
      }),
    history: () => history.content,
    transcript: () =>
      Transcript.makeTranscript({
        id: transcriptId,
        parentTranscriptId,
        messages: history.content,
      }),
  };
});

export const createSession = <const Definition extends AgentDefinition>(
  definition: Definition,
  options?: CreateSessionOptions,
): Effect.Effect<Session<ProvidersOf<Definition>>, AgentDefinitionError | TurnError, Scope.Scope> =>
  createSessionImpl(definition, options);
