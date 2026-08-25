import { Effect, Schema, Stream } from "effect";
import { Prompt } from "effect/unstable/ai";
import type { Response, Tool } from "effect/unstable/ai";
import type { CompiledAgent } from "../agent.js";
import type { ExtensionContexts } from "../extension.js";
import { provideExtensionHook } from "../extension.js";
import { hookTurnError, modelTurnError, TurnError } from "./errors.js";
import type { ApprovalResolvedEvent, PersistedTurnEvent, TurnEvent } from "./events.js";
import { beginHookPhase, transformPrompt } from "./hooks.js";
import type { RuntimeModel } from "./model-resolver.js";
import type { ToolExecution } from "./tool-execution.js";

export type StepEvent =
  | PersistedTurnEvent
  | {
      readonly type: "turn-complete";
      readonly history: Prompt.Prompt;
      readonly finishReason?: Response.FinishReason | undefined;
      readonly usage?: Response.Usage | undefined;
    };

export interface StepRunner {
  readonly run: (
    prompt: Prompt.Prompt,
    selected: RuntimeModel,
  ) => Stream.Stream<StepEvent, TurnError>;
}

export const makeStepRunner = (
  compiled: CompiledAgent,
  contexts: ExtensionContexts,
  toolExecution: ToolExecution,
): StepRunner => {
  const approvalEvents = (
    part: { readonly approvalId: string; readonly toolCallId: string },
    call: { readonly name: string; readonly params: unknown },
    record: (decision: Prompt.ToolApprovalResponsePart) => void,
  ): Stream.Stream<PersistedTurnEvent, TurnError> =>
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
            return Stream.succeed({
              type: "approval-resolved",
              approvalId: part.approvalId,
              toolCallId: part.toolCallId,
              approved: false,
              reason: outcome.reason,
            } satisfies ApprovalResolvedEvent);
          }
          return Stream.concat(
            Stream.succeed({
              type: "approval-required",
              approvalId: outcome.approvalId,
              toolCallId: outcome.toolCallId,
              name: outcome.name,
              params: outcome.params,
              approve: () => toolExecution.approval.resolve(outcome.approvalId, { approved: true }),
              deny: (reason) =>
                toolExecution.approval.resolve(outcome.approvalId, {
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
                        reason: decision.reason,
                      }),
                    );
                  }),
                ),
                Effect.map(
                  (decision) =>
                    ({
                      type: "approval-resolved",
                      approvalId: outcome.approvalId,
                      toolCallId: outcome.toolCallId,
                      approved: decision.approved,
                      reason: decision.reason,
                    }) satisfies ApprovalResolvedEvent,
                ),
              ),
            ),
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
        compiled.extensions,
        (extension) =>
          provideExtensionHook(extension, contexts, extension.hooks?.stepStart?.(prompt)),
        (extension) =>
          provideExtensionHook(extension, contexts, extension.hooks?.stepEnd?.(endPrompt, parts)),
        "Step end Hook failed",
      ).pipe(
        hookTurnError("Step start Hook failed"),
        Effect.map((stepHooks) =>
          Stream.unwrap(
            transformPrompt(compiled.extensions, contexts, prompt).pipe(
              hookTurnError("Pre-Step Hook failed"),
              Effect.map((transformed) => {
                endPrompt = transformed;
                // Tool.Any leaks handler services; context is supplied below and model errors map to TurnError.
                // SAFETY: ToolExecution provides every handler and the selected context below supplies model services.
                return (
                  selected.model.streamText({
                    prompt: transformed,
                    toolkit: toolExecution.toolkit,
                    concurrency: 1,
                  }) as Stream.Stream<Response.StreamPart<Record<string, Tool.Any>>, unknown>
                ).pipe(
                  Stream.provideContext(selected.context),
                  Stream.mapError(modelTurnError),
                  Stream.map((part) =>
                    part.type === "tool-result" && !Schema.is(Schema.Json)(part.encodedResult)
                      ? { ...part, encodedResult: null }
                      : part,
                  ),
                  Stream.tap((part) => Effect.sync(() => parts.push(part))),
                  Stream.flatMap((part): Stream.Stream<StepEvent, TurnError> => {
                    if (part.type === "error") return Stream.fail(modelTurnError(part.error));
                    if (part.type === "text-delta") {
                      return Stream.succeed({ type: "model-output", text: part.delta });
                    }
                    if (part.type === "reasoning-delta") {
                      return Stream.succeed({ type: "reasoning", text: part.delta });
                    }
                    if (part.type === "tool-call") {
                      toolCalls.set(part.id, part);
                      return Stream.succeed({
                        type: "tool-call",
                        id: part.id,
                        name: part.name,
                        params: part.params,
                      });
                    }
                    if (part.type === "tool-result") {
                      return Stream.succeed({
                        type: "tool-result",
                        id: part.id,
                        name: part.name,
                        result: part.result,
                        encodedResult: part.encodedResult,
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
                      const finish = parts.findLast(
                        (part): part is Response.FinishPart => part.type === "finish",
                      );
                      const next: Stream.Stream<StepEvent, TurnError> = parts.some(
                        (part) => part.type === "tool-call" && part.providerExecuted !== true,
                      )
                        ? run(nextPrompt, selected)
                        : Stream.succeed({
                            type: "turn-complete",
                            history: nextPrompt,
                            finishReason: finish?.reason,
                            usage: finish?.usage,
                          });
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
