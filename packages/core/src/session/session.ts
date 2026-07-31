import { Context, Effect, Layer, Scope, Stream } from "effect";
import { Prompt } from "effect/unstable/ai";
import { compileAgentDefinition } from "../agent.js";
import type { AgentDefinition, AgentDefinitionError } from "../agent.js";
import type { AnyProvider, QualifiedModelId } from "../provider.js";
import { provideExtensionHook } from "../extension.js";
import type { AnyExtension } from "../extension.js";
import { SessionBusyError, SessionReleasedError, TurnError, hookTurnError } from "./errors.js";
import type { TurnEvent } from "./events.js";
import { beginHookPhase } from "./hooks.js";
import { makeModelResolver } from "./model-resolver.js";
import { makeStepRunner } from "./step-runner.js";
import { makeToolExecution } from "./tool-execution.js";

type ProvidersOf<Definition extends AgentDefinition> =
  Definition extends AgentDefinition<infer Providers, any, any> ? Providers : never;

export interface PromptOptions<Providers extends ReadonlyArray<AnyProvider>> {
  readonly model: QualifiedModelId<Providers[number]>;
}

export interface Session<
  Providers extends ReadonlyArray<AnyProvider> = ReadonlyArray<AnyProvider>,
> {
  readonly prompt: (
    text: string,
    options?: PromptOptions<Providers>,
  ) => Stream.Stream<TurnEvent, SessionBusyError | SessionReleasedError | TurnError>;
  readonly history: () => ReadonlyArray<Prompt.Message>;
}

const createSessionImpl: (
  definition: AgentDefinition,
) => Effect.Effect<Session, AgentDefinitionError | TurnError, Scope.Scope> = Effect.fn(
  "@mitome/core/createSession",
)(function* (definition) {
  const compiled = yield* compileAgentDefinition(definition);

  const sessionScope = yield* Effect.scope;
  const extensionContexts = new Map<AnyExtension, Context.Context<any>>();
  for (const extension of compiled.extensions) {
    if (extension.resource !== undefined) {
      extensionContexts.set(
        extension,
        // The Extension's Resource type is erased by AnyExtension; provideExtension re-pairs it dynamically.
        (yield* Layer.build(extension.resource).pipe(
          hookTurnError("Extension setup failed"),
        )) as Context.Context<any>,
      );
    }
  }
  const toolExecution = yield* makeToolExecution(compiled, extensionContexts);
  const modelResolver = makeModelResolver(compiled.providers, sessionScope);
  const stepRunner = makeStepRunner(compiled, extensionContexts, toolExecution);
  let history = Prompt.make(
    compiled.instructions === "" ? [] : [{ role: "system", content: compiled.instructions }],
  );
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
    prompt: (text, options) =>
      Stream.suspend<TurnEvent, SessionBusyError | SessionReleasedError | TurnError, never>(() => {
        if (isReleased) {
          return Stream.fail(new SessionReleasedError({}));
        }
        if (isTurnActive) {
          return Stream.fail(new SessionBusyError({}));
        }
        const qualifiedModelId = options?.model ?? definition.model;
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
                        Effect.map(() => {
                          const { type: _type, history: nextHistory, ...finish } = event;
                          history = nextHistory;
                          return { type: "response-complete", ...finish } as const;
                        }),
                      );
                    }),
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
  };
});

export const createSession = createSessionImpl as <const Definition extends AgentDefinition>(
  definition: Definition,
) => Effect.Effect<Session<ProvidersOf<Definition>>, AgentDefinitionError | TurnError, Scope.Scope>;
