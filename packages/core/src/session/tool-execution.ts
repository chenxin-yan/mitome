import { Cause, Deferred, Effect, Schema, Stream } from "effect";
import { Tool, Toolkit, type AiError } from "effect/unstable/ai";
import type { CompiledAgent, CompiledTool } from "../agent.js";
import type { PluginContexts, ToolResultValidator } from "../plugin.js";
import { providePlugin } from "../plugin.js";
import { ApprovalResolutionError, hookAiError, toolAiError } from "./errors.js";
import type { ToolExecutionDenied } from "./events.js";

export type ApprovalDecision = { readonly approved: boolean; readonly reason?: string };

export type ApprovalRequestOutcome =
  | { readonly _tag: "Failure"; readonly message: string; readonly cause: unknown }
  | { readonly _tag: "Veto"; readonly reason: string }
  | {
      readonly _tag: "Pending";
      readonly approvalId: string;
      readonly toolCallId: string;
      readonly name: string;
      readonly params: unknown;
      readonly awaitDecision: Effect.Effect<ApprovalDecision>;
    };

export interface ApprovalGate {
  readonly request: (
    part: { readonly approvalId: string; readonly toolCallId: string },
    call: { readonly name: string; readonly params: unknown },
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

type PreparedCall =
  | {
      readonly _tag: "Ready";
      readonly pipeline: ToolPipeline;
      readonly params: unknown;
      readonly veto: string | undefined;
    }
  | {
      readonly _tag: "Failure";
      readonly pipeline: ToolPipeline;
      readonly params: unknown;
      readonly message: string;
      readonly cause: unknown;
    };

type ToolPipeline = {
  readonly compiled: CompiledTool;
  readonly execute: (
    params: unknown,
  ) => Effect.Effect<Stream.Stream<Tool.HandlerResult<Tool.Any>>, AiError.AiError>;
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

const validateResult = (
  tool: Tool.Any,
  handlerResult: Tool.HandlerResult<Tool.Any>,
  result: unknown,
  validator: ToolResultValidator | undefined,
): Effect.Effect<Tool.HandlerResult<Tool.Any>, unknown> =>
  Effect.gen(function* () {
    // Result validators describe successful SDK outputs; failures use their Tool failure schema instead.
    const validated =
      handlerResult.isFailure || validator === undefined ? result : yield* validator(result);
    // Dynamic Tools have no failure schema to re-encode with, so the Hook-transformed
    // value doubles as the encoded payload the model sees.
    if (handlerResult.isFailure && Tool.isDynamic(tool) && tool.failureSchema === Schema.Never) {
      return {
        ...handlerResult,
        result: validated,
        encodedResult: validated,
      } as Tool.HandlerResult<Tool.Any>;
    }
    const schema = handlerResult.isFailure ? tool.failureSchema : tool.successSchema;
    const encodedResult = yield* Schema.encodeUnknownEffect(schema)(validated);
    return {
      result: validated,
      encodedResult,
      isFailure: handlerResult.isFailure,
      preliminary: handlerResult.preliminary,
    } as Tool.HandlerResult<Tool.Any>;
  }) as Effect.Effect<Tool.HandlerResult<Tool.Any>, unknown>;

/**
 * Builds the complete Tool Call pipeline. The Session keeps `concurrency: 1`,
 * serializing preparation and execution per ADR-0005.
 */
export const makeToolExecution = (
  compiled: CompiledAgent,
  contexts: PluginContexts,
): Effect.Effect<ToolExecution> => {
  const compiledTools = Array.from(compiled.tools.values());
  const toolkit = Toolkit.make(...compiledTools.map(({ tool }) => tool));
  const toolHandlers = Object.fromEntries(
    compiledTools.flatMap(({ tool, handler }) =>
      handler === undefined ? [] : [[tool.name, handler] as const],
    ),
  );

  // Cross-Plugin handlers are heterogeneous, so their merged record cannot satisfy Toolkit.HandlersFrom.
  return toolkit.toHandlers(toolHandlers as never).pipe(
    Effect.flatMap((handlers) => Effect.provide(toolkit, handlers)),
    Effect.map((handlers): ToolExecution => {
      const baseHandle = handlers.handle as Toolkit.WithHandler<Record<string, Tool.Any>>["handle"];
      const preparedCalls = new Map<string, PreparedCall>();
      const pendingApprovals = new Map<string, Deferred.Deferred<ApprovalDecision>>();

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

      const pipelines = Object.fromEntries(
        compiledTools.map((compiledTool) => {
          const { owner, resultValidator, tool } = compiledTool;
          const execute: ToolPipeline["execute"] = Effect.fn("@mitome/core/ToolPipeline.execute")(
            function* (params) {
              // The whole Tool Call runs in the owning Plugin's context: the handler
              // plus any schema decode/encode services from its Resource.
              const results = yield* providePlugin(
                owner,
                contexts,
                baseHandle(tool.name, params).pipe(
                  Effect.flatMap((stream) =>
                    Stream.runCollect(
                      // Collection keeps the handler stream and Hooks inside
                      // streamText's per-call concurrency slot (ADR-0005).
                      // handle's typed error is `never` only because handlers were erased via
                      // `as never`; `unknown` is the honest runtime channel that toolAiError maps.
                      stream as unknown as Stream.Stream<Tool.HandlerResult<Tool.Any>, unknown>,
                    ),
                  ),
                ),
              ).pipe(toolAiError(tool.name));
              if (!compiled.plugins.some((plugin) => plugin.hooks?.postTool !== undefined)) {
                return Stream.fromIterable(results);
              }
              const finalResults = yield* Effect.forEach(results, (handlerResult) =>
                Effect.gen(function* () {
                  let result = handlerResult.result;
                  for (const plugin of compiled.plugins) {
                    const postTool = plugin.hooks?.postTool;
                    if (postTool !== undefined) {
                      result = yield* providePlugin(
                        plugin,
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
                  return yield* providePlugin(
                    owner,
                    contexts,
                    validateResult(tool, handlerResult, result, resultValidator),
                  ).pipe(hookAiError("postTool", "Post-Tool result validation failed"));
                }),
              );
              return Stream.fromIterable(finalResults);
            },
          );
          return [tool.name, { compiled: compiledTool, execute } satisfies ToolPipeline] as const;
        }),
      ) as Record<string, ToolPipeline>;

      const prepare: (pipeline: ToolPipeline, params: unknown) => Effect.Effect<PreparedCall> =
        Effect.fn("@mitome/core/ToolExecution.prepare")(function* (pipeline, params) {
          const { inputValidator, tool } = pipeline.compiled;
          const input =
            inputValidator === undefined
              ? { _tag: "Ready" as const, value: params }
              : yield* inputValidator(params).pipe(
                  Effect.map((value) => ({ _tag: "Ready" as const, value })),
                  Effect.catch((cause) =>
                    Effect.succeed({ _tag: "Failure" as const, value: params, cause }),
                  ),
                );
          if (input._tag === "Failure") {
            return {
              _tag: "Failure",
              pipeline,
              params,
              message: "Tool input validation failed",
              cause: input.cause,
            };
          }
          const preTool = yield* runPreTool(tool.name, input.value).pipe(
            Effect.map((veto) => ({ _tag: "Ready" as const, veto })),
            Effect.catch((cause) => Effect.succeed({ _tag: "Failure" as const, cause })),
          );
          return preTool._tag === "Failure"
            ? {
                _tag: "Failure",
                pipeline,
                params: input.value,
                message: "Pre-Tool Hook failed",
                cause: preTool.cause,
              }
            : {
                _tag: "Ready",
                pipeline,
                params: input.value,
                veto: preTool.veto,
              };
        });

      const tools = Object.fromEntries(
        compiledTools.map((compiledTool) => {
          const pipeline = pipelines[compiledTool.tool.name] as ToolPipeline;
          const needsApproval = compiledTool.tool.needsApproval;
          const wrapped = compiledTool.tool.setNeedsApproval(
            (params: unknown, context: Tool.NeedsApprovalContext) =>
              Effect.gen(function* () {
                const prepared = yield* prepare(pipeline, params);
                preparedCalls.set(context.toolCallId, prepared);
                if (prepared._tag === "Failure" || prepared.veto !== undefined) return true;
                if (needsApproval === undefined || typeof needsApproval === "boolean") {
                  return needsApproval ?? false;
                }
                // Sync throws become defects; the Cause-level handlers below treat
                // Fail and Die identically (log, then fail closed).
                return yield* Effect.sync(() =>
                  needsApproval(prepared.params as never, context),
                ).pipe(
                  Effect.flatMap((result) =>
                    Effect.isEffect(result) ? result : Effect.succeed(result),
                  ),
                  // Predicate failures cannot execute the Tool Call: log and fail closed.
                  Effect.tapCause((cause) =>
                    Effect.logWarning(
                      `needsApproval predicate for "${compiledTool.tool.name}" failed`,
                      cause,
                    ),
                  ),
                  Effect.catchCause((cause) =>
                    Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(true),
                  ),
                );
              }),
          ) as Tool.Any;
          return [compiledTool.tool.name, wrapped] as const;
        }),
      ) as Record<string, Tool.Any>;

      const handle = ((name: string, params: unknown, toolCallId?: string) =>
        Effect.gen(function* () {
          const prepared = toolCallId === undefined ? undefined : preparedCalls.get(toolCallId);
          const pipeline = prepared?.pipeline ?? (pipelines[name] as ToolPipeline);
          if (toolCallId !== undefined) preparedCalls.delete(toolCallId);
          const veto =
            prepared === undefined
              ? yield* runPreTool(name, params).pipe(hookAiError("preTool", "Pre-Tool Hook failed"))
              : prepared._tag === "Ready"
                ? prepared.veto
                : undefined;
          if (veto !== undefined) return Stream.succeed(failureResult(veto));
          return yield* pipeline.execute(params);
        })) as Toolkit.WithHandler<Record<string, Tool.Any>>["handle"];

      const request: ApprovalGate["request"] = Effect.fn("@mitome/core/ApprovalGate.request")(
        function* (part, call) {
          const prepared = preparedCalls.get(part.toolCallId);
          if (prepared?._tag === "Failure") {
            preparedCalls.delete(part.toolCallId);
            return {
              _tag: "Failure",
              message: prepared.message,
              cause: prepared.cause,
            };
          }
          if (prepared?.veto !== undefined) {
            preparedCalls.delete(part.toolCallId);
            return { _tag: "Veto", reason: prepared.veto };
          }
          const deferred = yield* Deferred.make<ApprovalDecision>();
          pendingApprovals.set(part.approvalId, deferred);
          return {
            _tag: "Pending",
            approvalId: part.approvalId,
            toolCallId: part.toolCallId,
            name: call.name,
            params: prepared === undefined ? call.params : prepared.params,
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
          } satisfies ApprovalRequestOutcome;
        },
      );

      const resolve: ApprovalGate["resolve"] = Effect.fn("@mitome/core/ApprovalGate.resolve")(
        function* (id, decision) {
          const deferred = pendingApprovals.get(id);
          if (deferred === undefined) return yield* new ApprovalResolutionError({});
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
