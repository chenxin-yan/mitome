import { Cause, Data, Deferred, Effect, Predicate, Schema, Stream } from "effect";
import { AiError, Tool, Toolkit } from "effect/unstable/ai";
import type { CompiledAgent, CompiledTool } from "../agent.js";
import type {
  ExtensionContexts,
  ToolFailureValidator,
  ToolInput,
  ToolOutput,
  ToolResultValidator,
} from "../extension.js";
import { provideExtension } from "../extension.js";
import { ApprovalResolutionError, hookAiError, toolAiError } from "./errors.js";
import type { ApprovalRequirement, ToolExecutionDenied } from "./events.js";

export type ApprovalDecision = { readonly approved: boolean; readonly reason?: string };

export type ApprovalRequestOutcome =
  | { readonly _tag: "Failure"; readonly message: string; readonly cause: unknown }
  | { readonly _tag: "Veto"; readonly reason: string }
  | {
      readonly _tag: "Pending";
      readonly approvalId: string;
      readonly toolCallId: string;
      readonly name: string;
      readonly params: ToolInput;
      readonly requirement: ApprovalRequirement;
      readonly awaitDecision: Effect.Effect<ApprovalDecision>;
    };

const ApprovalRequest = Data.taggedEnum<ApprovalRequestOutcome>();

export interface ApprovalGate {
  readonly request: (
    part: { readonly approvalId: string; readonly toolCallId: string },
    call: { readonly name: string; readonly params: ToolInput },
  ) => Effect.Effect<ApprovalRequestOutcome>;
  readonly resolve: (
    id: string,
    decision: ApprovalDecision,
  ) => Effect.Effect<void, ApprovalResolutionError>;
  readonly reset: () => void;
}

/** The complete Tool Call pipeline and its internal Approval decision gate. */
export interface ToolExecution {
  readonly toolkit: Toolkit.WithHandler<Record<string, Tool.Any>>;
  readonly approval: ApprovalGate;
}

// The merged Approval decision, computed once per Tool Call and cached: a veto/deny reason the
// Model sees, an Approval requirement the Host resolves, or neither (the call runs unattended).
type PreparedCall =
  | {
      readonly _tag: "Ready";
      readonly pipeline: ToolPipeline;
      readonly params: ToolInput;
      readonly veto: string | undefined;
      readonly requirement: ApprovalRequirement | undefined;
    }
  | {
      readonly _tag: "InputFailure";
      readonly pipeline: ToolPipeline;
      readonly params: ToolInput;
      readonly reason: string;
    }
  | {
      readonly _tag: "TurnFailure";
      readonly pipeline: ToolPipeline;
      readonly params: ToolInput;
      readonly method: string;
      readonly message: string;
      readonly cause: unknown;
    };

const PreparedCall = Data.taggedEnum<PreparedCall>();

// Extension vetoes and the Agent's `approvals`, merged: any veto or `deny` denies, otherwise any
// `"ask"` asks, otherwise an explicit `allow` skips the Tool's own `needsApproval`.
type GateOutcome =
  | { readonly _tag: "Denied"; readonly reason: string }
  | { readonly _tag: "Passed"; readonly decision: "allow" | "ask" | undefined }
  | {
      readonly _tag: "Failure";
      readonly method: string;
      readonly message: string;
      readonly cause: unknown;
    };

const GateOutcome = Data.taggedEnum<GateOutcome>();

class ApprovalPolicyError extends Data.TaggedError("ApprovalPolicyError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const policyDecisions: ReadonlyArray<unknown> = ["allow", "ask", "deny", undefined];

const policyDenialReason = (name: string): string =>
  `Tool call "${name}" is denied by the Agent's approval policy`;

const interruptOrFailure = (cause: Cause.Cause<unknown>) =>
  Cause.hasInterruptsOnly(cause)
    ? Effect.interrupt
    : Effect.succeed({ _tag: "Failure" as const, cause: Cause.squash(cause) });

type ToolPipeline = {
  readonly compiled: CompiledTool;
  readonly execute: (
    params: ToolInput,
  ) => Effect.Effect<Stream.Stream<Tool.HandlerResult<Tool.Any>>, AiError.AiError>;
};

const failureResult = (reason: string): Tool.HandlerResult<Tool.Any> => {
  const result: ToolExecutionDenied = { type: "execution-denied", reason };
  return {
    result,
    encodedResult: result,
    isFailure: true,
    preliminary: false,
  };
};

const validateResult = (
  tool: Tool.Any,
  handlerResult: Tool.HandlerResult<Tool.Any>,
  result: ToolOutput,
  resultValidator: ToolResultValidator | undefined,
  failureValidator: ToolFailureValidator | undefined,
): Effect.Effect<Tool.HandlerResult<Tool.Any>, unknown> => {
  // SAFETY: the owning Extension context is supplied by the caller around this schema encoding.
  return Effect.gen(function* () {
    // Classify before Hooks: transformed defects stay opaque, while transformed expected
    // failures still pass through their declared failure schema.
    const isDefect = handlerResult.isFailure && AiError.isAiError(handlerResult.result);
    const transformed = isDefect ? handlerResult.result : result;
    const validator = handlerResult.isFailure
      ? isDefect
        ? undefined
        : failureValidator
      : resultValidator;
    const validated = validator === undefined ? transformed : yield* validator(transformed);
    // Dynamic Tools have no failure schema to re-encode with, so the validated value
    // doubles as the encoded payload the model sees.
    if (handlerResult.isFailure && Tool.isDynamic(tool) && tool.failureSchema === Schema.Never) {
      return {
        ...handlerResult,
        result: validated,
        encodedResult: validated,
      };
    }
    const schema = handlerResult.isFailure ? tool.failureSchema : tool.successSchema;
    const encodedResult = yield* Schema.encodeUnknownEffect(schema)(validated);
    return {
      result: validated,
      encodedResult,
      isFailure: handlerResult.isFailure,
      preliminary: handlerResult.preliminary,
    };
  }) as Effect.Effect<Tool.HandlerResult<Tool.Any>, unknown>;
};

const widenStreamError = <A, E, R>(stream: Stream.Stream<A, E, R>): Stream.Stream<A, unknown, R> =>
  stream;

/**
 * Builds the complete Tool Call pipeline. The Session keeps `concurrency: 1`,
 * serializing preparation and execution per ADR-0005.
 */
export const makeToolExecution = (
  compiled: CompiledAgent,
  contexts: ExtensionContexts,
): Effect.Effect<ToolExecution> => {
  const compiledTools = Array.from(compiled.tools.values());
  const toolkit = Toolkit.make(...compiledTools.map(({ tool }) => tool));
  const toolHandlers = Object.fromEntries(
    compiledTools.flatMap(({ tool, handler }) =>
      handler === undefined ? [] : [[tool.name, handler] as const],
    ),
  );

  // Definitions already type-check handlers; erase their heterogeneous merged internal record here.
  // SAFETY: compileAgentDefinition pairs each handler with the Tool that owns its parameter schema.
  return toolkit.toHandlers(toolHandlers as never).pipe(
    Effect.flatMap((handlers) => Effect.provide(toolkit, handlers)),
    Effect.map((handlers): ToolExecution => {
      // SAFETY: the toolkit was built from the same compiled Tools used to construct these handlers.
      const baseHandle = handlers.handle as Toolkit.WithHandler<Record<string, Tool.Any>>["handle"];
      const preparedCalls = new Map<string, PreparedCall>();
      const pendingApprovals = new Map<string, Deferred.Deferred<ApprovalDecision>>();

      const runPreTool = (
        name: string,
        params: ToolInput,
      ): Effect.Effect<{ readonly veto: string | undefined; readonly ask: boolean }, unknown> =>
        Effect.gen(function* () {
          let ask = false;
          for (const extension of compiled.extensions) {
            const result = yield* provideExtension(
              extension,
              contexts,
              extension.hooks?.preTool?.({ name, params }) ?? Effect.void,
            );
            if (result === "ask") ask = true;
            else if (result !== undefined) return { veto: result.reason, ask };
          }
          return { veto: undefined, ask };
        });

      const gate = (
        name: string,
        params: ToolInput,
        toolCallId: string,
      ): Effect.Effect<GateOutcome> =>
        Effect.gen(function* () {
          const preTool = yield* runPreTool(name, params).pipe(
            Effect.map((hooks) => ({ _tag: "Hooks" as const, ...hooks })),
            Effect.catch((cause) => Effect.succeed({ _tag: "Failure" as const, cause })),
            Effect.catchCause(interruptOrFailure),
          );
          if (Predicate.isTagged(preTool, "Failure")) {
            return GateOutcome.Failure({
              method: "preTool",
              message: "Pre-Tool Hook failed",
              cause: preTool.cause,
            });
          }
          if (preTool.veto !== undefined) return GateOutcome.Denied({ reason: preTool.veto });
          const policy = compiled.approvals;
          if (policy === undefined) {
            return GateOutcome.Passed({ decision: preTool.ask ? "ask" : undefined });
          }
          // The callback is synchronous by contract, so a Promise or Effect is an invalid decision.
          // A throw is wrapped so its text never reaches a user-facing description (ADR-0044).
          const decision = yield* Effect.try({
            try: () => policy({ name, params, toolCallId }),
            catch: (cause) => new ApprovalPolicyError({ message: "Approval policy threw", cause }),
          }).pipe(
            Effect.filterOrFail(
              (result) => policyDecisions.includes(result),
              () =>
                new ApprovalPolicyError({
                  message: "Approval policy returned an invalid decision",
                }),
            ),
            Effect.map((result) => ({ _tag: "Decision" as const, result })),
            Effect.catchCause(interruptOrFailure),
          );
          if (Predicate.isTagged(decision, "Failure")) {
            return GateOutcome.Failure({
              method: "approvals",
              message: "Approval policy failed",
              cause: decision.cause,
            });
          }
          if (decision.result === "deny") {
            return GateOutcome.Denied({ reason: policyDenialReason(name) });
          }
          return GateOutcome.Passed({
            decision: preTool.ask || decision.result === "ask" ? "ask" : decision.result,
          });
        });

      const pipelines = Object.fromEntries(
        compiledTools.map((compiledTool) => {
          const { failureValidator, owner, resultValidator, tool } = compiledTool;
          const execute: ToolPipeline["execute"] = Effect.fn("@mitome/core/ToolPipeline.execute")(
            function* (params) {
              // The whole Tool Call runs in the owning Extension's context: the handler
              // plus any schema decode/encode services from its Resource.
              const results = yield* provideExtension(
                owner,
                contexts,
                baseHandle(tool.name, params).pipe(
                  Effect.flatMap((stream) =>
                    Stream.runCollect(
                      // Collection keeps the handler stream and Hooks inside
                      // streamText's per-call concurrency slot (ADR-0005).
                      // handle's typed error is `never` only because handlers were erased via
                      // `as never`; `unknown` is the honest runtime channel that toolAiError maps.
                      widenStreamError(stream),
                    ),
                  ),
                ),
              ).pipe(toolAiError(tool.name));
              if (
                !compiled.extensions.some((extension) => extension.hooks?.postTool !== undefined)
              ) {
                return Stream.fromIterable(results);
              }
              const finalResults = yield* Effect.forEach(results, (handlerResult) =>
                Effect.gen(function* () {
                  let result = handlerResult.result;
                  for (const extension of compiled.extensions) {
                    const postTool = extension.hooks?.postTool;
                    if (postTool !== undefined) {
                      result = yield* provideExtension(
                        extension,
                        contexts,
                        postTool({
                          name: tool.name,
                          params,
                          result,
                          isFailure: handlerResult.isFailure,
                        }),
                      ).pipe(hookAiError("postTool", "Post-Tool Hook failed"));
                    }
                  }
                  return yield* provideExtension(
                    owner,
                    contexts,
                    validateResult(tool, handlerResult, result, resultValidator, failureValidator),
                  ).pipe(hookAiError("postTool", "Post-Tool result validation failed"));
                }),
              );
              return Stream.fromIterable(finalResults);
            },
          );
          return [tool.name, { compiled: compiledTool, execute } satisfies ToolPipeline] as const;
        }),
      );

      const prepare: (
        pipeline: ToolPipeline,
        params: ToolInput,
        context: Tool.NeedsApprovalContext,
      ) => Effect.Effect<PreparedCall> = Effect.fn("@mitome/core/ToolExecution.prepare")(
        function* (pipeline, params, context) {
          const { inputValidator, tool } = pipeline.compiled;
          const input =
            inputValidator === undefined
              ? { _tag: "Ready" as const, value: params }
              : yield* inputValidator(params).pipe(
                  Effect.map((value) => ({ _tag: "Ready" as const, value })),
                  Effect.catch((cause) =>
                    Effect.succeed({
                      _tag: "InputFailure" as const,
                      reason: `Tool input validation failed: ${cause instanceof Error ? cause.message : String(cause)}`,
                    }),
                  ),
                  Effect.catchCause(interruptOrFailure),
                );
          if (Predicate.isTagged(input, "InputFailure")) {
            return PreparedCall.InputFailure({ pipeline, params, reason: input.reason });
          }
          if (Predicate.isTagged(input, "Failure")) {
            return PreparedCall.TurnFailure({
              pipeline,
              params,
              method: tool.name,
              message: "Tool input validator failed",
              cause: input.cause,
            });
          }
          const gated = yield* gate(tool.name, input.value, context.toolCallId);
          if (Predicate.isTagged(gated, "Failure")) {
            return PreparedCall.TurnFailure({ pipeline, params: input.value, ...gated });
          }
          const ready = (requirement: ApprovalRequirement | undefined, veto?: string) =>
            PreparedCall.Ready({ pipeline, params: input.value, veto, requirement });
          if (Predicate.isTagged(gated, "Denied")) return ready(undefined, gated.reason);
          if (gated.decision === "ask") return ready("policy");
          if (gated.decision === "allow") return ready(undefined);
          const needsApproval = tool.needsApproval;
          if (needsApproval === undefined || Predicate.isBoolean(needsApproval)) {
            return ready(needsApproval === true ? "tool" : undefined);
          }
          // Sync throws become defects; the Cause-level handler treats Fail and Die identically
          // (log, then fail closed) where Effect's own LanguageModel would fail open.
          return yield* Effect.sync(() => needsApproval(input.value, context)).pipe(
            Effect.flatMap((result) => (Effect.isEffect(result) ? result : Effect.succeed(result))),
            Effect.map((required) => ready(required ? "tool" : undefined)),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.logWarning(
                    `needsApproval predicate for "${tool.name}" failed`,
                    cause,
                  ).pipe(Effect.as(ready("predicate-error"))),
            ),
          );
        },
      );

      const tools = Object.fromEntries(
        compiledTools.map((compiledTool) => {
          // SAFETY: pipelines is constructed from every compiled Tool immediately above.
          const pipeline = pipelines[compiledTool.tool.name]!;
          const wrapped = compiledTool.tool.setNeedsApproval(
            (params: ToolInput, context: Tool.NeedsApprovalContext) =>
              Effect.map(prepare(pipeline, params, context), (prepared) => {
                preparedCalls.set(context.toolCallId, prepared);
                if (Predicate.isTagged(prepared, "InputFailure")) return false;
                if (Predicate.isTagged(prepared, "TurnFailure")) return true;
                return prepared.veto !== undefined || prepared.requirement !== undefined;
              }),
          );
          return [compiledTool.tool.name, wrapped] as const;
        }),
      );

      // SAFETY: toolAiError maps all erased handler errors to AiError before this function returns.
      const handle = ((name: string, params: ToolInput, toolCallId?: string) =>
        Effect.gen(function* () {
          const prepared = toolCallId === undefined ? undefined : preparedCalls.get(toolCallId);
          // SAFETY: handle is only invoked for names exposed by this toolkit.
          const pipeline = prepared?.pipeline ?? pipelines[name]!;
          if (toolCallId !== undefined) preparedCalls.delete(toolCallId);
          if (prepared?._tag === "InputFailure") {
            return Stream.succeed(failureResult(prepared.reason));
          }
          if (prepared?._tag === "TurnFailure") {
            return yield* Effect.fail(prepared.cause).pipe(
              hookAiError(prepared.method, prepared.message),
            );
          }
          if (prepared !== undefined) {
            return prepared.veto === undefined
              ? yield* pipeline.execute(params)
              : Stream.succeed(failureResult(prepared.veto));
          }
          // Defensive path for a call the model pipeline never prepared: enforce vetoes and
          // denials, which Core owns; an unresolvable "ask" cannot be honored here. The model
          // pipeline always supplies an id; only direct handle() calls may omit it.
          const gated = yield* gate(name, params, toolCallId ?? "");
          if (Predicate.isTagged(gated, "Failure")) {
            return yield* Effect.fail(gated.cause).pipe(hookAiError(gated.method, gated.message));
          }
          if (Predicate.isTagged(gated, "Denied"))
            return Stream.succeed(failureResult(gated.reason));
          return yield* pipeline.execute(params);
        })) as Toolkit.WithHandler<Record<string, Tool.Any>>["handle"];

      const request: ApprovalGate["request"] = Effect.fn("@mitome/core/ApprovalGate.request")(
        function* (part, call) {
          const prepared = preparedCalls.get(part.toolCallId);
          if (prepared?._tag === "InputFailure") {
            preparedCalls.delete(part.toolCallId);
            return ApprovalRequest.Failure({
              message: prepared.reason,
              cause: prepared.reason,
            });
          }
          if (prepared?._tag === "TurnFailure") {
            preparedCalls.delete(part.toolCallId);
            return ApprovalRequest.Failure({
              message: prepared.message,
              cause: prepared.cause,
            });
          }
          if (prepared?.veto !== undefined) {
            preparedCalls.delete(part.toolCallId);
            return ApprovalRequest.Veto({ reason: prepared.veto });
          }
          if (prepared?.requirement === undefined) {
            return ApprovalRequest.Failure({
              message: "Tool approval request has no prepared Tool call",
              cause: part,
            });
          }
          const deferred = yield* Deferred.make<ApprovalDecision>();
          pendingApprovals.set(part.approvalId, deferred);
          return ApprovalRequest.Pending({
            approvalId: part.approvalId,
            toolCallId: part.toolCallId,
            name: call.name,
            params: prepared.params,
            requirement: prepared.requirement,
            awaitDecision: Deferred.await(deferred).pipe(
              Effect.tap((decision) =>
                Effect.sync(() => {
                  if (!decision.approved) preparedCalls.delete(part.toolCallId);
                }),
              ),
              Effect.ensuring(
                Deferred.succeed(deferred, {
                  approved: false,
                  reason: "Approval decision is no longer pending",
                }).pipe(Effect.asVoid),
              ),
            ),
          });
        },
      );

      const resolve: ApprovalGate["resolve"] = Effect.fn("@mitome/core/ApprovalGate.resolve")(
        function* (id, decision) {
          const deferred = pendingApprovals.get(id);
          if (deferred === undefined) {
            return yield* new ApprovalResolutionError({ reason: "not-pending" });
          }
          const resolved = yield* Deferred.succeed(deferred, decision);
          if (!resolved) return yield* new ApprovalResolutionError({});
        },
      );

      return {
        toolkit: { tools, handle },
        approval: {
          request,
          resolve,
          reset: () => {
            preparedCalls.clear();
            pendingApprovals.clear();
          },
        },
      };
    }),
  );
};
