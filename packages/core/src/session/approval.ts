import { Deferred, Effect, Semaphore, Stream } from "effect";
import { Prompt, Tool, Toolkit } from "effect/unstable/ai";
import type { AnyPlugin, PluginContexts, ToolInputValidator } from "../plugin.js";
import { providePlugin } from "../plugin.js";
import { ApprovalResolutionError, TurnError, hookAiError } from "./errors.js";
import type { ToolExecutionDenied, TurnEvent } from "./events.js";
import type { ComposedToolkit } from "./toolkit.js";

type ApprovalDecision = { readonly approved: boolean; readonly reason?: string };

type PreparedTool =
  | {
      readonly _tag: "ok";
      readonly key: string;
      readonly toolCallId: string;
      readonly params: unknown;
      readonly veto: string | undefined;
    }
  | {
      readonly _tag: "failure";
      readonly key: string;
      readonly toolCallId: string;
      readonly params: unknown;
      readonly hookFailure: unknown;
    };

type ApprovalOutcome =
  | { readonly _tag: "hook-failure"; readonly cause: unknown }
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
 * evaluation, user Approval resolution, and the Session-wide serialization of
 * Tool execution (one permit; Tool handler streams and their Hooks cannot
 * overlap while model output still streams).
 *
 * TODO: drop the semaphore once streamText honors concurrency: 1 (effect#6596).
 */
export const makeApprovals = (
  plugins: ReadonlyArray<AnyPlugin>,
  contexts: PluginContexts,
  base: ComposedToolkit,
): Effect.Effect<Approvals> =>
  Effect.map(Semaphore.make(1), (semaphore) => {
    const preparedByKey = new Map<string, Array<PreparedTool>>();
    const preparedByCallId = new Map<string, PreparedTool>();
    // Toolkit.handle lacks toolCallId, so name+params keys are FIFO. The handler
    // retries a miss with decoded params to match transforming/defaulting schemas.
    // TODO: collapse to preparedByCallId and remove the handle cast once handle receives toolCallId (effect#6597).
    const canonicalize = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(canonicalize)
        : typeof value === "object" && value !== null
          ? Object.fromEntries(
              Object.entries(value)
                .sort(([left], [right]) => (left < right ? -1 : 1))
                .map(([key, entry]) => [key, canonicalize(entry)]),
            )
          : value;
    const keyFor = (name: string, params: unknown) =>
      `${name}:${JSON.stringify(canonicalize(params))}`;
    const discardPrepared = (toolCallId: string): void => {
      const prepared = preparedByCallId.get(toolCallId);
      if (prepared === undefined) return;
      preparedByCallId.delete(toolCallId);
      const items = preparedByKey.get(prepared.key)!;
      const index = items.indexOf(prepared);
      // Absent when a same-key shift in the wrapped handle already consumed it.
      if (index >= 0) items.splice(index, 1);
    };
    const runPreTool = (
      name: string,
      params: unknown,
    ): Effect.Effect<string | undefined, unknown> =>
      Effect.gen(function* () {
        for (const plugin of plugins) {
          const veto = yield* providePlugin(
            plugin,
            contexts,
            plugin.hooks?.preTool?.({ name, params }) ?? Effect.void,
          );
          if (veto !== undefined) return veto.reason;
        }
        return undefined;
      });
    const inputValidators: Readonly<Record<string, ToolInputValidator>> = Object.assign(
      {},
      ...plugins.map((plugin) => plugin.toolInputValidators ?? {}),
    );

    const tools = Object.fromEntries(
      Object.entries(base.tools).map(([toolKey, tool]) => {
        const needsApproval = tool.needsApproval;
        // No with-needsApproval combinator exists upstream, so clone the Tool;
        // assumes Tool instances keep their data in enumerable own properties.
        // TODO: use Tool.setNeedsApproval once it exists (effect#6600).
        const wrapped = Object.assign(Object.create(Object.getPrototypeOf(tool)), tool, {
          needsApproval: (params: unknown, context: Tool.NeedsApprovalContext) =>
            semaphore.withPermit(
              Effect.gen(function* () {
                const inputValidator = inputValidators[tool.name];
                const input =
                  inputValidator === undefined
                    ? { _tag: "ok" as const, value: params }
                    : yield* inputValidator(params).pipe(
                        Effect.map((value) => ({ _tag: "ok" as const, value })),
                        Effect.catch((cause) =>
                          Effect.succeed({ _tag: "failure" as const, value: params, cause }),
                        ),
                      );
                const preTool = yield* runPreTool(tool.name, input.value).pipe(
                  Effect.map((veto) => ({ _tag: "ok" as const, veto })),
                  Effect.catch((cause) => Effect.succeed({ _tag: "failure" as const, cause })),
                );
                const prepared: PreparedTool =
                  preTool._tag === "failure"
                    ? {
                        _tag: "failure",
                        key: keyFor(tool.name, inputValidator === undefined ? input.value : params),
                        toolCallId: context.toolCallId,
                        params: input.value,
                        hookFailure: preTool.cause,
                      }
                    : {
                        _tag: "ok",
                        key: keyFor(tool.name, inputValidator === undefined ? input.value : params),
                        toolCallId: context.toolCallId,
                        params: input.value,
                        veto: preTool.veto,
                      };
                const items = preparedByKey.get(prepared.key) ?? [];
                items.push(prepared);
                preparedByKey.set(prepared.key, items);
                preparedByCallId.set(context.toolCallId, prepared);

                if (preTool._tag === "failure" || preTool.veto !== undefined) return true;
                if (needsApproval === undefined || typeof needsApproval === "boolean") {
                  return needsApproval ?? false;
                }
                if (input._tag === "failure") return true;
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
                  Effect.orElseSucceed(() => true),
                );
              }),
            ),
        }) as Tool.Any;
        return [toolKey, wrapped];
      }),
    ) as Record<string, Tool.Any>;

    const handle = ((name: string, params: unknown) =>
      semaphore.withPermit(
        Effect.gen(function* () {
          let prepared = preparedByKey.get(keyFor(name, params))?.shift();
          if (prepared === undefined) {
            const decodedParams = yield* base.decodeParameters(name, params).pipe(
              // The composed handle owns parameter failures; this decode only retries the prepared lookup.
              Effect.orElseSucceed(() => params),
            );
            prepared = preparedByKey.get(keyFor(name, decodedParams))?.shift();
          }
          if (prepared !== undefined) preparedByCallId.delete(prepared.toolCallId);
          const veto =
            prepared === undefined
              ? yield* runPreTool(name, params).pipe(hookAiError("preTool", "Pre-Tool Hook failed"))
              : prepared._tag === "ok"
                ? prepared.veto
                : undefined;
          if (veto !== undefined) return Stream.succeed(failureResult(veto));
          return yield* base.execute(name, params);
        }),
      )) as Toolkit.WithHandler<Record<string, Tool.Any>>["handle"];

    const outcomeFor = (toolCallId: string): ApprovalOutcome => {
      const prepared = preparedByCallId.get(toolCallId);
      if (prepared?._tag === "failure") {
        discardPrepared(toolCallId);
        return { _tag: "hook-failure", cause: prepared.hookFailure };
      }
      if (prepared?.veto !== undefined) {
        discardPrepared(toolCallId);
        return { _tag: "veto", reason: prepared.veto };
      }
      return {
        _tag: "approval",
        params: prepared === undefined ? undefined : { value: prepared.params },
        discard: () => discardPrepared(toolCallId),
      };
    };

    const onApprovalRequest: Approvals["onApprovalRequest"] = (part, call, record) => {
      const approval = outcomeFor(part.toolCallId);
      if (approval._tag === "hook-failure") {
        return Stream.fail(
          new TurnError({ message: "Pre-Tool Hook failed", cause: approval.cause }),
        );
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
        preparedByKey.clear();
        preparedByCallId.clear();
      },
    };
  });
