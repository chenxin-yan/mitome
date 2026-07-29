import { Effect, Stream } from "effect";
import { Prompt, Tool } from "effect/unstable/ai";
import type { Response } from "effect/unstable/ai";
import type { CompiledAgent } from "../agent.js";
import type { AnyPlugin, PluginContexts } from "../plugin.js";
import { providePlugin } from "../plugin.js";
import { hookTurnError, modelTurnError, TurnError } from "./errors.js";
import type { TurnEvent } from "./events.js";
import { beginHookPhase, transformPrompt } from "./hooks.js";
import type { RuntimeModel } from "./model-resolver.js";
import type { ToolExecution } from "./tool-execution.js";

export type StepEvent =
  | TurnEvent
  | { readonly type: "turn-complete"; readonly history: Prompt.Prompt };

export interface StepRunner {
  readonly run: (
    prompt: Prompt.Prompt,
    selected: RuntimeModel,
  ) => Stream.Stream<StepEvent, TurnError>;
}

export const makeStepRunner = (
  compiled: CompiledAgent,
  contexts: PluginContexts,
  toolExecution: ToolExecution,
): StepRunner => {
  const inContext = <A, E>(
    plugin: AnyPlugin,
    effect: Effect.Effect<A, E, any> | undefined,
  ): Effect.Effect<A, E> | undefined =>
    effect === undefined ? undefined : providePlugin(plugin, contexts, effect);

  const approvalEvents = (
    part: { readonly approvalId: string; readonly toolCallId: string },
    call: { readonly name: string; readonly params: unknown },
    record: (decision: Prompt.ToolApprovalResponsePart) => void,
  ): Stream.Stream<TurnEvent, TurnError> =>
    Stream.unwrap(
      toolExecution.approval.request(part, call).pipe(
        Effect.map((outcome) => {
          if (outcome._tag === "Failure") {
            return Stream.fail(new TurnError({ message: outcome.message, cause: outcome.cause }));
          }
          if (outcome._tag === "Veto") {
            record(
              Prompt.toolApprovalResponsePart({
                approvalId: part.approvalId,
                approved: false,
                reason: outcome.reason,
              }),
            );
            return Stream.empty;
          }
          return Stream.concat(
            Stream.succeed({
              type: "approval-required",
              approvalId: outcome.approvalId,
              toolCallId: outcome.toolCallId,
              name: outcome.name,
              params: outcome.params,
              approve: () => toolExecution.approval.resolve(outcome.id, { approved: true }),
              deny: (reason) =>
                toolExecution.approval.resolve(outcome.id, {
                  approved: false,
                  reason: reason ?? "Approval denied",
                }),
            } satisfies TurnEvent),
            Stream.fromEffect(
              outcome.awaitDecision.pipe(
                Effect.tap((decision) =>
                  Effect.sync(() => {
                    record(
                      Prompt.toolApprovalResponsePart({
                        approvalId: outcome.approvalId,
                        approved: decision.approved,
                        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
                      }),
                    );
                  }),
                ),
              ),
            ).pipe(Stream.drain),
          );
        }),
      ),
    );

  const run = (
    prompt: Prompt.Prompt,
    selected: RuntimeModel,
  ): Stream.Stream<StepEvent, TurnError> => {
    const parts: Array<Response.AnyPart> = [];
    const toolCalls = new Map<string, Response.ToolCallPart<string, unknown>>();
    const decisions: Array<Prompt.ToolApprovalResponsePart> = [];
    let endPrompt = prompt;
    return Stream.unwrap(
      beginHookPhase(
        compiled.plugins,
        (plugin) => inContext(plugin, plugin.hooks?.stepStart?.(prompt)),
        (plugin) => inContext(plugin, plugin.hooks?.stepEnd?.(endPrompt)),
        "Step end Hook failed",
      ).pipe(
        hookTurnError("Step start Hook failed"),
        Effect.map((stepHooks) =>
          Stream.unwrap(
            transformPrompt(compiled.plugins, contexts, prompt).pipe(
              hookTurnError("Pre-Step Hook failed"),
              Effect.map((transformed) => {
                endPrompt = transformed;
                return (
                  selected.model.streamText({
                    prompt: transformed,
                    toolkit: toolExecution.toolkit,
                    concurrency: 1,
                  }) as Stream.Stream<Response.StreamPart<Record<string, Tool.Any>>, unknown>
                ).pipe(
                  Stream.provideContext(selected.context),
                  Stream.mapError(modelTurnError),
                  Stream.tap((part) => Effect.sync(() => parts.push(part))),
                  Stream.flatMap((part): Stream.Stream<StepEvent, TurnError> => {
                    if (part.type === "text-delta") {
                      return Stream.succeed({ type: "model-output", text: part.delta });
                    }
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
                    return approvalEvents(part, call, (decision) => decisions.push(decision));
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
                        ? run(nextPrompt, selected)
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
          ).pipe(Stream.onExit(() => stepHooks.cleanup)),
        ),
      ),
    );
  };

  return { run };
};
