import { Cause, Deferred, Effect, Stream } from "effect";
import { Prompt, Tool, Toolkit } from "effect/unstable/ai";
import type { CompiledAgent } from "../agent.js";
import type { PluginContexts } from "../plugin.js";
import { providePlugin } from "../plugin.js";
import { ApprovalResolutionError, TurnError, hookAiError } from "./errors.js";
import type { ToolExecutionDenied, TurnEvent } from "./events.js";
import type { ComposedToolkit } from "./toolkit.js";

type ApprovalDecision = { readonly approved: boolean; readonly reason?: string };

type PreparedTool =
  | {
      readonly _tag: "ok";
      readonly params: unknown;
      readonly veto: string | undefined;
    }
  | {
      readonly _tag: "failure";
      readonly params: unknown;
      readonly message: string;
      readonly cause: unknown;
    };

type ApprovalOutcome =
  | { readonly _tag: "failure"; readonly message: string; readonly cause: unknown }
  | { readonly _tag: "veto"; readonly reason: string }
  | {
      readonly _tag: "approval";
      readonly params: { readonly value: unknown } | undefined;
      readonly discard: () => void;
    };

const failureResult = (reason: string): Tool.HandlerResult<Tool.Any> => {
  const result: ToolExecutionDenied = { type: "execution-denied", reason };
  return {
    result,
    encodedResult: result,
    isFailure: true,
    preliminary: false,
  } as Tool.HandlerResult<Tool.Any>;
};

/** The approval lifecycle a Session consumes: gate Tools, resolve requests, reset per Turn. */
export type Approvals = {
  readonly toolkit: Toolkit.WithHandler<Record<string, Tool.Any>>;
  readonly onApprovalRequest: (
    part: { readonly approvalId: string; readonly toolCallId: string },
    call: { readonly name: string; readonly params: unknown },
    record: (decision: Prompt.ToolApprovalResponsePart) => void,
  ) => Stream.Stream<TurnEvent, TurnError>;
  readonly reset: () => void;
};

/**
 * Owns whether a pending Tool call executes: pre-Tool veto Hooks, needsApproval
 * evaluation, and user Approval resolution. Sequencing relies on the Session
 * passing `concurrency: 1` to streamText, which serializes needsApproval and
 * handler execution together per call (ADR-0005).
 */
export const makeApprovals = (
  compiled: CompiledAgent,
  contexts: PluginContexts,
  base: ComposedToolkit,
): Effect.Effect<Approvals> =>
  Effect.sync(() => {
    const preparedByCallId = new Map<string, PreparedTool>();
    const runPreTool = (
      name: string,
      params: unknown,
    ): Effect.Effect<string | undefined, unknown> =>
      Effect.gen(function* () {
        for (const plugin of compiled.plugins) {
          const veto = yield* providePlugin(
            plugin,
            contexts,
            plugin.hooks?.preTool?.({ name, params }) ?? Effect.void,
          );
          if (veto !== undefined) return veto.reason;
        }
        return undefined;
      });
    const tools = Object.fromEntries(
      Object.entries(base.tools).map(([toolKey, tool]) => {
        const needsApproval = tool.needsApproval;
        const wrapped = tool.setNeedsApproval(
          (params: unknown, context: Tool.NeedsApprovalContext) =>
            Effect.gen(function* () {
              const inputValidator = compiled.toolInputValidators[tool.name];
              const input =
                inputValidator === undefined
                  ? { _tag: "ok" as const, value: params }
                  : yield* inputValidator(params).pipe(
                      Effect.map((value) => ({ _tag: "ok" as const, value })),
                      Effect.catch((cause) =>
                        Effect.succeed({ _tag: "failure" as const, value: params, cause }),
                      ),
                    );
              const preTool =
                input._tag === "failure"
                  ? undefined
                  : yield* runPreTool(tool.name, input.value).pipe(
                      Effect.map((veto) => ({ _tag: "ok" as const, veto })),
                      Effect.catch((cause) => Effect.succeed({ _tag: "failure" as const, cause })),
                    );
              const prepared: PreparedTool =
                input._tag === "failure"
                  ? {
                      _tag: "failure",
                      params,
                      message: "Tool input validation failed",
                      cause: input.cause,
                    }
                  : preTool?._tag === "failure"
                    ? {
                        _tag: "failure",
                        params: input.value,
                        message: "Pre-Tool Hook failed",
                        cause: preTool.cause,
                      }
                    : {
                        _tag: "ok",
                        params: input.value,
                        veto: preTool?.veto,
                      };
              preparedByCallId.set(context.toolCallId, prepared);

              if (prepared._tag === "failure" || prepared.veto !== undefined) return true;
              if (needsApproval === undefined || typeof needsApproval === "boolean") {
                return needsApproval ?? false;
              }
              // @effect-diagnostics-next-line unknownInEffectCatch:off
              return yield* Effect.try({
                try: () => needsApproval(input.value as never, context),
                catch: (cause) => cause,
              }).pipe(
                Effect.flatMap((result) =>
                  Effect.isEffect(result) ? result : Effect.succeed(result),
                ),
                // Predicate failures cannot execute the Tool: log and fail closed.
                Effect.tapCause((cause) =>
                  Effect.logWarning(`needsApproval predicate for "${tool.name}" failed`, cause),
                ),
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(true),
                ),
              );
            }),
        ) as Tool.Any;
        return [toolKey, wrapped];
      }),
    ) as Record<string, Tool.Any>;

    const handle = ((name: string, params: unknown, toolCallId?: string) =>
      Effect.gen(function* () {
        const prepared = toolCallId === undefined ? undefined : preparedByCallId.get(toolCallId);
        if (toolCallId !== undefined) preparedByCallId.delete(toolCallId);
        const veto =
          prepared === undefined
            ? yield* runPreTool(name, params).pipe(hookAiError("preTool", "Pre-Tool Hook failed"))
            : prepared._tag === "ok"
              ? prepared.veto
              : undefined;
        if (veto !== undefined) return Stream.succeed(failureResult(veto));
        return yield* base.execute(name, params);
      })) as Toolkit.WithHandler<Record<string, Tool.Any>>["handle"];

    const outcomeFor = (toolCallId: string): ApprovalOutcome => {
      const prepared = preparedByCallId.get(toolCallId);
      if (prepared?._tag === "failure") {
        preparedByCallId.delete(toolCallId);
        return { _tag: "failure", message: prepared.message, cause: prepared.cause };
      }
      if (prepared?.veto !== undefined) {
        preparedByCallId.delete(toolCallId);
        return { _tag: "veto", reason: prepared.veto };
      }
      return {
        _tag: "approval",
        params: prepared === undefined ? undefined : { value: prepared.params },
        discard: () => void preparedByCallId.delete(toolCallId),
      };
    };

    const onApprovalRequest: Approvals["onApprovalRequest"] = (part, call, record) => {
      const approval = outcomeFor(part.toolCallId);
      if (approval._tag === "failure") {
        return Stream.fail(new TurnError({ message: approval.message, cause: approval.cause }));
      }
      if (approval._tag === "veto") {
        record(
          Prompt.toolApprovalResponsePart({
            approvalId: part.approvalId,
            approved: false,
            reason: approval.reason,
          }),
        );
        return Stream.empty;
      }
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
                params: approval.params === undefined ? call.params : approval.params.value,
                approve: () => resolve({ approved: true }),
                deny: (reason) => resolve({ approved: false, reason: reason ?? "Approval denied" }),
              } satisfies TurnEvent),
              Stream.fromEffect(
                Deferred.await(deferred).pipe(
                  Effect.tap((decision) =>
                    Effect.sync(() => {
                      record(
                        Prompt.toolApprovalResponsePart({
                          approvalId: part.approvalId,
                          approved: decision.approved,
                          ...(decision.reason === undefined ? {} : { reason: decision.reason }),
                        }),
                      );
                      if (!decision.approved) approval.discard();
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
    };

    return {
      toolkit: { tools, handle },
      onApprovalRequest,
      reset: () => {
        preparedByCallId.clear();
      },
    };
  });
