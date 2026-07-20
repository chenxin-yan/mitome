import { Context, Deferred, Effect, Layer, Scope, Semaphore, Stream } from "effect";
import { LanguageModel, Prompt, Tool } from "effect/unstable/ai";
import type { Response } from "effect/unstable/ai";
import { validateAgentDefinition } from "./definition.js";
import type { AgentDefinition, AgentDefinitionError, AnyPlugin } from "./definition.js";
import {
  ApprovalResolutionError,
  SessionBusyError,
  SessionReleasedError,
  TurnError,
  TurnStepLimitError,
} from "./errors.js";
import type { TurnEvent } from "./events.js";
import {
  type HookProgress,
  hookTurnError,
  modelTurnError,
  runCleanupHooks,
  runEndHooks,
  runStartHooks,
} from "./hooks.js";
import { getModelLayer } from "./model.js";
import { providePlugin, transformPrompt } from "./tool-runtime.js";
import { makeToolkit } from "./toolkit.js";

const maximumTurnSteps = 16;

type ApprovalDecision = { readonly approved: boolean; readonly reason?: string };

export interface Session {
  readonly prompt: (
    text: string,
  ) => Stream.Stream<
    TurnEvent,
    SessionBusyError | SessionReleasedError | TurnStepLimitError | TurnError
  >;
  readonly history: () => ReadonlyArray<Prompt.Message>;
  readonly released: () => boolean;
}

export const createSession: (
  definition: AgentDefinition,
) => Effect.Effect<Session, AgentDefinitionError | TurnError, Scope.Scope> = Effect.fn(
  "@mitome/core/createSession",
)(function* (definition) {
  yield* validateAgentDefinition(definition);

  const layer = getModelLayer(definition.model);
  if (layer === undefined) {
    return yield* Effect.die(new Error("Model was not created by @mitome/core"));
  }

  const context = yield* Layer.build(layer).pipe(
    Effect.mapError(
      (cause) =>
        new TurnError({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    ),
  );
  const model = Context.get(context, LanguageModel.LanguageModel);
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
  const semaphore = yield* Semaphore.make(1);
  const approvalToolkit = yield* makeToolkit(definition.plugins, pluginContexts, semaphore);
  let history = Prompt.make([{ role: "system", content: definition.instructions }]);
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

  yield* runStartHooks(
    definition.plugins,
    (plugin) => inContext(plugin, plugin.hooks?.sessionStart),
    (plugin) => inContext(plugin, plugin.hooks?.sessionEnd),
    "Session end Hook failed",
  ).pipe(hookTurnError("Session start Hook failed"));

  yield* Effect.addFinalizer(() =>
    // A failing sessionEnd Hook must not fail scope close or skip later cleanup.
    runCleanupHooks(
      definition.plugins,
      (plugin) => inContext(plugin, plugin.hooks?.sessionEnd),
      "Session end Hook failed",
    ),
  );

  type StepEvent = TurnEvent | { readonly type: "turn-complete"; readonly history: Prompt.Prompt };

  const runStep = (
    prompt: Prompt.Prompt,
    step: number,
  ): Stream.Stream<StepEvent, TurnStepLimitError | TurnError> => {
    if (step >= maximumTurnSteps) {
      return Stream.fail(
        new TurnStepLimitError({
          message: `Turn exceeded the ${maximumTurnSteps} model Step limit`,
        }),
      );
    }

    const parts: Array<Response.AnyPart> = [];
    const toolCalls = new Map<string, { readonly name: string; readonly params: unknown }>();
    const decisions: Array<Prompt.ToolApprovalResponsePart> = [];
    return Stream.unwrap(
      runStartHooks(
        definition.plugins,
        (plugin) => inContext(plugin, plugin.hooks?.stepStart?.(prompt)),
        (plugin) => inContext(plugin, plugin.hooks?.stepEnd?.(prompt)),
        "Step end Hook failed",
      ).pipe(
        hookTurnError("Step start Hook failed"),
        Effect.map(() => {
          const startedPlugins = definition.plugins;
          const endProgress: HookProgress = { dispatched: 0 };
          let endPrompt = prompt;
          return Stream.unwrap(
            transformPrompt(definition.plugins, pluginContexts, prompt).pipe(
              hookTurnError("Pre-Step Hook failed"),
              Effect.map((transformed) => {
                endPrompt = transformed;
                return (
                  model.streamText({
                    prompt: transformed,
                    toolkit: approvalToolkit.toolkit,
                  }) as Stream.Stream<Response.StreamPart<Record<string, Tool.Any>>, unknown>
                ).pipe(
                  Stream.mapError(modelTurnError),
                  Stream.tap((part) => Effect.sync(() => parts.push(part))),
                  Stream.flatMap((part): Stream.Stream<StepEvent, TurnError> => {
                    if (part.type === "text-delta")
                      return Stream.succeed({ type: "model-output", text: part.delta });
                    if (part.type === "tool-call") {
                      toolCalls.set(part.id, { name: part.name, params: part.params });
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

                    const preToolFailure = approvalToolkit.preToolFailure(part.toolCallId);
                    if (preToolFailure !== undefined) {
                      return Stream.fail(
                        new TurnError({
                          message: "Pre-Tool Hook failed",
                          cause: preToolFailure.cause,
                        }),
                      );
                    }
                    const veto = approvalToolkit.vetoReason(part.toolCallId);
                    if (veto !== undefined) {
                      decisions.push(
                        Prompt.toolApprovalResponsePart({
                          approvalId: part.approvalId,
                          approved: false,
                          reason: veto,
                        }),
                      );
                      return Stream.empty;
                    }
                    const call = toolCalls.get(part.toolCallId);
                    if (call === undefined) {
                      return Stream.fail(
                        new TurnError({
                          message: "Tool approval request is missing its Tool call",
                          cause: part,
                        }),
                      );
                    }
                    const preparedParams = approvalToolkit.preparedParams(part.toolCallId);
                    return Stream.unwrap(
                      Deferred.make<ApprovalDecision>().pipe(
                        Effect.map((deferred) => {
                          const resolve = (decision: ApprovalDecision) =>
                            Deferred.succeed(deferred, decision).pipe(
                              Effect.flatMap((resolved) =>
                                resolved
                                  ? Effect.void
                                  : Effect.fail(
                                      new ApprovalResolutionError({
                                        message: "Approval decision has already been resolved",
                                      }),
                                    ),
                              ),
                            );
                          return Stream.concat(
                            Stream.succeed({
                              type: "approval-required",
                              approvalId: part.approvalId,
                              toolCallId: part.toolCallId,
                              name: call.name,
                              params:
                                preparedParams === undefined ? call.params : preparedParams.value,
                              approve: () => resolve({ approved: true }),
                              deny: (reason) =>
                                resolve({ approved: false, reason: reason ?? "Approval denied" }),
                            } satisfies TurnEvent),
                            Stream.fromEffect(
                              Deferred.await(deferred).pipe(
                                Effect.tap((decision) =>
                                  Effect.sync(() => {
                                    decisions.push(
                                      Prompt.toolApprovalResponsePart({
                                        approvalId: part.approvalId,
                                        approved: decision.approved,
                                        ...(decision.reason === undefined
                                          ? {}
                                          : { reason: decision.reason }),
                                      }),
                                    );
                                    if (!decision.approved)
                                      approvalToolkit.discardPrepared(part.toolCallId);
                                  }),
                                ),
                                Effect.ensuring(
                                  Deferred.succeed(deferred, {
                                    approved: false,
                                    reason: "Approval decision is no longer pending",
                                  }).pipe(Effect.asVoid),
                                ),
                              ),
                            ).pipe(Stream.drain),
                          );
                        }),
                      ),
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
                      const next: Stream.Stream<StepEvent, TurnStepLimitError | TurnError> =
                        parts.some(
                          (part) => part.type === "tool-call" && part.providerExecuted !== true,
                        )
                          ? runStep(nextPrompt, step + 1)
                          : Stream.succeed({ type: "turn-complete", history: nextPrompt });
                      return Stream.concat(
                        Stream.fromEffectDrain(
                          runEndHooks(
                            startedPlugins,
                            (plugin) => inContext(plugin, plugin.hooks?.stepEnd?.(transformed)),
                            endProgress,
                            "Step end Hook failed",
                          ).pipe(hookTurnError("Step end Hook failed")),
                        ),
                        next,
                      );
                    }),
                  ),
                );
              }),
            ),
          ).pipe(
            Stream.onExit(() =>
              runCleanupHooks(
                startedPlugins.slice(endProgress.dispatched),
                (plugin) => inContext(plugin, plugin.hooks?.stepEnd?.(endPrompt)),
                "Step end Hook failed",
              ),
            ),
          );
        }),
      ),
    );
  };

  return {
    prompt: (text) =>
      Stream.suspend<
        TurnEvent,
        SessionBusyError | SessionReleasedError | TurnStepLimitError | TurnError,
        never
      >(() => {
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
        isTurnActive = true;
        return Stream.unwrap(
          runStartHooks(
            definition.plugins,
            (plugin) => inContext(plugin, plugin.hooks?.turnStart?.(text)),
            (plugin) => inContext(plugin, plugin.hooks?.turnEnd?.(text)),
            "Turn end Hook failed",
          ).pipe(
            hookTurnError("Turn start Hook failed"),
            Effect.map(() => {
              const startedPlugins = definition.plugins;
              const endProgress: HookProgress = { dispatched: 0 };
              return runStep(Prompt.concat(history, text), 0).pipe(
                Stream.mapEffect((event): Effect.Effect<TurnEvent, TurnError> => {
                  if (event.type !== "turn-complete") return Effect.succeed(event);
                  return runEndHooks(
                    startedPlugins,
                    (plugin) => inContext(plugin, plugin.hooks?.turnEnd?.(text)),
                    endProgress,
                    "Turn end Hook failed",
                  ).pipe(
                    hookTurnError("Turn end Hook failed"),
                    Effect.map(() => {
                      history = event.history;
                      return { type: "response-complete" } as const;
                    }),
                  );
                }),
                Stream.onExit(() =>
                  runCleanupHooks(
                    startedPlugins.slice(endProgress.dispatched),
                    (plugin) => inContext(plugin, plugin.hooks?.turnEnd?.(text)),
                    "Turn end Hook failed",
                  ),
                ),
              );
            }),
          ),
        ).pipe(
          Stream.ensuring(
            Effect.sync(() => {
              approvalToolkit.clearPrepared();
              isTurnActive = false;
            }),
          ),
        );
      }),
    history: () => history.content,
    released: () => isReleased,
  };
});
