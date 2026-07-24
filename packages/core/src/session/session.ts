import { Context, Effect, Layer, Scope, Stream } from "effect";
import { LanguageModel, Prompt, Tool } from "effect/unstable/ai";
import type { Response } from "effect/unstable/ai";
import { validateAgentDefinition } from "../agent.js";
import type { AgentDefinition, AgentDefinitionError } from "../agent.js";
import { getProviderMetadata, parseModelIdentifier } from "../provider.js";
import type { AnyProvider, ModelIdentifier } from "../provider.js";
import { providePlugin } from "../plugin.js";
import type { AnyPlugin } from "../plugin.js";
import { makeApprovals } from "./approval.js";
import {
  SessionBusyError,
  SessionReleasedError,
  TurnError,
  hookTurnError,
  modelTurnError,
} from "./errors.js";
import type { TurnEvent } from "./events.js";
import { beginHookPhase, transformPrompt } from "./hooks.js";
import { makeToolkit } from "./toolkit.js";

type ProvidersOf<Definition extends AgentDefinition> =
  Definition extends AgentDefinition<infer Providers, any, any> ? Providers : never;

export interface PromptOptions<Providers extends ReadonlyArray<AnyProvider>> {
  readonly model: ModelIdentifier<Providers[number]>;
}

export interface Session<
  Providers extends ReadonlyArray<AnyProvider> = ReadonlyArray<AnyProvider>,
> {
  readonly prompt: (
    text: string,
    options?: PromptOptions<Providers>,
  ) => Stream.Stream<TurnEvent, SessionBusyError | SessionReleasedError | TurnError>;
  readonly history: () => ReadonlyArray<Prompt.Message>;
  readonly released: () => boolean;
}

type RuntimeModel = {
  readonly context: Context.Context<LanguageModel.LanguageModel>;
  readonly model: LanguageModel.Service;
};

const modelSetupTurnError = (cause: unknown) =>
  new TurnError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

const createSessionImpl: (
  definition: AgentDefinition,
) => Effect.Effect<Session, AgentDefinitionError | TurnError, Scope.Scope> = Effect.fn(
  "@mitome/core/createSession",
)(function* (definition) {
  yield* validateAgentDefinition(definition);

  const sessionScope = yield* Effect.scope;
  const providers = new Map(definition.providers.map((provider) => [provider.id, provider]));
  const models = new Map<string, RuntimeModel>();
  const pluginContexts = new Map<AnyPlugin, Context.Context<any>>();
  for (const plugin of definition.plugins) {
    if (plugin.resource !== undefined) {
      pluginContexts.set(
        plugin,
        // The Plugin's Resource type is erased by AnyPlugin; providePlugin re-pairs it dynamically.
        (yield* Layer.build(plugin.resource).pipe(
          hookTurnError("Plugin setup failed"),
        )) as Context.Context<any>,
      );
    }
  }
  const approvals = yield* makeApprovals(
    definition.plugins,
    pluginContexts,
    yield* makeToolkit(definition.plugins, pluginContexts),
  );
  const instructions = definition.plugins
    .map((plugin) => plugin.instructions)
    .filter((fragment) => fragment !== undefined && fragment !== "")
    .join("\n\n");
  let history = Prompt.make(instructions === "" ? [] : [{ role: "system", content: instructions }]);
  let isReleased = false;
  let isTurnActive = false;

  // Hooks run with their Plugin's scoped resource (if any) in context.
  const inContext = <A, E>(
    plugin: AnyPlugin,
    effect: Effect.Effect<A, E, any> | undefined,
  ): Effect.Effect<A, E> | undefined =>
    effect === undefined ? undefined : providePlugin(plugin, pluginContexts, effect);

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      history = Prompt.empty;
      isReleased = true;
    }),
  );

  const sessionHooks = yield* beginHookPhase(
    definition.plugins,
    (plugin) => inContext(plugin, plugin.hooks?.sessionStart),
    (plugin) => inContext(plugin, plugin.hooks?.sessionEnd),
    "Session end Hook failed",
  ).pipe(hookTurnError("Session start Hook failed"));

  // A failing sessionEnd Hook must not fail scope close or skip later cleanup.
  yield* Effect.addFinalizer(() => sessionHooks.cleanup);

  type StepEvent = TurnEvent | { readonly type: "turn-complete"; readonly history: Prompt.Prompt };

  const runStep = (prompt: Prompt.Prompt, selected: RuntimeModel) => {
    const parts: Array<Response.AnyPart> = [];
    const toolCalls = new Map<string, Response.ToolCallPart<string, unknown>>();
    const decisions: Array<Prompt.ToolApprovalResponsePart> = [];
    let endPrompt = prompt;
    return Stream.unwrap(
      beginHookPhase(
        definition.plugins,
        (plugin) => inContext(plugin, plugin.hooks?.stepStart?.(prompt)),
        (plugin) => inContext(plugin, plugin.hooks?.stepEnd?.(endPrompt)),
        "Step end Hook failed",
      ).pipe(
        hookTurnError("Step start Hook failed"),
        Effect.map((stepHooks) => {
          return Stream.unwrap(
            transformPrompt(definition.plugins, pluginContexts, prompt).pipe(
              hookTurnError("Pre-Step Hook failed"),
              Effect.map((transformed) => {
                endPrompt = transformed;
                return (
                  selected.model.streamText({
                    prompt: transformed,
                    toolkit: approvals.toolkit,
                  }) as Stream.Stream<Response.StreamPart<Record<string, Tool.Any>>, unknown>
                ).pipe(
                  Stream.provideContext(selected.context),
                  Stream.mapError(modelTurnError),
                  Stream.tap((part) => Effect.sync(() => parts.push(part))),
                  Stream.flatMap((part): Stream.Stream<StepEvent, TurnError> => {
                    if (part.type === "text-delta")
                      return Stream.succeed({ type: "model-output", text: part.delta });
                    if (part.type === "tool-call") {
                      toolCalls.set(part.id, part);
                      return Stream.succeed({ type: "tool-call", id: part.id, name: part.name });
                    }
                    if (part.type === "tool-result") {
                      return Stream.succeed({
                        type: "tool-result",
                        id: part.id,
                        name: part.name,
                        result: part.result,
                        isFailure: part.isFailure,
                      });
                    }
                    if (part.type !== "tool-approval-request") return Stream.empty;

                    const call = toolCalls.get(part.toolCallId);
                    if (call === undefined) {
                      return Stream.fail(
                        new TurnError({
                          message: "Tool approval request is missing its Tool call",
                          cause: part,
                        }),
                      );
                    }
                    return approvals.onApprovalRequest(part, call, (decision) =>
                      decisions.push(decision),
                    );
                  }),
                  Stream.concat(
                    Stream.suspend(() => {
                      const responsePrompt = Prompt.concat(prompt, Prompt.fromResponseParts(parts));
                      const nextPrompt =
                        decisions.length === 0
                          ? responsePrompt
                          : Prompt.concat(
                              responsePrompt,
                              Prompt.fromMessages([
                                Prompt.makeMessage("tool", { content: decisions }),
                              ]),
                            );
                      const next: Stream.Stream<StepEvent, TurnError> = parts.some(
                        (part) => part.type === "tool-call" && part.providerExecuted !== true,
                      )
                        ? runStep(nextPrompt, selected)
                        : Stream.succeed({ type: "turn-complete", history: nextPrompt });
                      return Stream.concat(
                        Stream.fromEffectDrain(
                          stepHooks.end.pipe(hookTurnError("Step end Hook failed")),
                        ),
                        next,
                      );
                    }),
                  ),
                );
              }),
            ),
          ).pipe(Stream.onExit(() => stepHooks.cleanup));
        }),
      ),
    );
  };

  const resolveModel = (identifier: unknown): Effect.Effect<RuntimeModel, TurnError> => {
    const parsed = parseModelIdentifier(identifier);
    if (parsed === undefined) {
      return Effect.fail(
        new TurnError({
          message: `Malformed Model identifier: ${String(identifier)}`,
          cause: identifier,
        }),
      );
    }
    const provider = providers.get(parsed.providerId);
    if (provider === undefined) {
      return Effect.fail(
        new TurnError({
          message: `Unregistered Provider id: ${parsed.providerId}`,
          cause: identifier,
        }),
      );
    }

    const modelIdentifier = identifier as string;
    const cached = models.get(modelIdentifier);
    if (cached !== undefined) return Effect.succeed(cached);

    const metadata = getProviderMetadata(provider)!;
    return Effect.try({
      try: () => metadata.provision(parsed.modelId),
      catch: modelSetupTurnError,
    }).pipe(
      Effect.flatMap((layer) =>
        Layer.buildWithScope(layer, sessionScope).pipe(Effect.mapError(modelSetupTurnError)),
      ),
      Effect.map((context) => {
        const selected = {
          context,
          model: Context.get(context, LanguageModel.LanguageModel),
        };
        models.set(modelIdentifier, selected);
        return selected;
      }),
    );
  };

  return {
    prompt: (text, options) =>
      Stream.suspend<TurnEvent, SessionBusyError | SessionReleasedError | TurnError, never>(() => {
        if (isReleased) {
          return Stream.fail(
            new SessionReleasedError({ message: "Session scope has been released" }),
          );
        }
        if (isTurnActive) {
          return Stream.fail(
            new SessionBusyError({ message: "Session is busy with an active Turn" }),
          );
        }
        const identifier = options?.model ?? definition.model;
        isTurnActive = true;
        return Stream.unwrap(
          resolveModel(identifier).pipe(
            Effect.flatMap((selected) =>
              beginHookPhase(
                definition.plugins,
                (plugin) => inContext(plugin, plugin.hooks?.turnStart?.(text)),
                (plugin) => inContext(plugin, plugin.hooks?.turnEnd?.(text)),
                "Turn end Hook failed",
              ).pipe(
                hookTurnError("Turn start Hook failed"),
                Effect.map((turnHooks) =>
                  runStep(Prompt.concat(history, text), selected).pipe(
                    Stream.mapEffect((event) => {
                      if (event.type !== "turn-complete") return Effect.succeed(event);
                      return turnHooks.end.pipe(
                        hookTurnError("Turn end Hook failed"),
                        Effect.map(() => {
                          history = event.history;
                          return { type: "response-complete" } as const;
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
              approvals.reset();
              isTurnActive = false;
            }),
          ),
        );
      }),
    history: () => history.content,
    released: () => isReleased,
  };
});

export const createSession = createSessionImpl as <const Definition extends AgentDefinition>(
  definition: Definition,
) => Effect.Effect<Session<ProvidersOf<Definition>>, AgentDefinitionError | TurnError, Scope.Scope>;
