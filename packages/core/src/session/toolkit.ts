import { Effect, Schema, Semaphore, Stream } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import type {
  AnyPlugin,
  PluginContexts,
  ToolInputValidator,
  ToolResultValidator,
} from "../plugin.js";
import { providePlugin } from "../plugin.js";
import { hookAiError, toolAiError } from "./errors.js";
import type { ToolExecutionDenied } from "./events.js";

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
    const validated = validator === undefined ? result : yield* validator(result);
    const schema = handlerResult.isFailure ? tool.failureSchema : tool.successSchema;
    const encodedResult = yield* Schema.encodeUnknownEffect(schema)(validated);
    return {
      result: validated,
      encodedResult,
      isFailure: handlerResult.isFailure,
      preliminary: handlerResult.preliminary,
    } as Tool.HandlerResult<Tool.Any>;
  }) as Effect.Effect<Tool.HandlerResult<Tool.Any>, unknown>;

type ApprovalOutcome =
  | { readonly _tag: "hook-failure"; readonly cause: unknown }
  | { readonly _tag: "veto"; readonly reason: string }
  | {
      readonly _tag: "approval";
      readonly params: { readonly value: unknown } | undefined;
      readonly discard: () => void;
    };

export type ApprovalToolkit = {
  readonly toolkit: Toolkit.WithHandler<Record<string, Tool.Any>>;
  readonly approvalOutcome: (toolCallId: string) => ApprovalOutcome;
  readonly clearPrepared: () => void;
};

export const makeToolkit = (
  plugins: ReadonlyArray<AnyPlugin>,
  contexts: PluginContexts,
  semaphore: Semaphore.Semaphore,
): Effect.Effect<ApprovalToolkit, never> => {
  const preparedByKey = new Map<string, Array<PreparedTool>>();
  const preparedByCallId = new Map<string, PreparedTool>();
  // Toolkit.handle lacks toolCallId, so name+params keys are FIFO. The handler
  // retries a miss with decoded params to match transforming/defaulting schemas.
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
    // Absent when a same-key shift in wrappedHandle already consumed it.
    if (index >= 0) items.splice(index, 1);
  };
  const runPreTool = (name: string, params: unknown): Effect.Effect<string | undefined, unknown> =>
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
  const baseTools = plugins.flatMap((plugin) => Object.values(plugin.toolkit?.tools ?? {}));
  const owners = new Map<string, AnyPlugin>();
  for (const plugin of plugins) {
    for (const tool of Object.values(plugin.toolkit?.tools ?? {})) owners.set(tool.name, plugin);
  }
  const inputValidators: Readonly<Record<string, ToolInputValidator>> = Object.assign(
    {},
    ...plugins.map((plugin) => plugin.toolInputValidators ?? {}),
  );
  const validators: Readonly<Record<string, ToolResultValidator>> = Object.assign(
    {},
    ...plugins.map((plugin) => plugin.toolResultValidators ?? {}),
  );
  const tools = baseTools.map((tool) => {
    const needsApproval = tool.needsApproval;
    // No with-needsApproval combinator exists upstream, so clone the Tool;
    // assumes Tool instances keep their data in enumerable own properties.
    return Object.assign(Object.create(Object.getPrototypeOf(tool)), tool, {
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
  });
  const toolkit = Toolkit.make(...tools);
  return toolkit
    .toHandlers(Object.assign({}, ...plugins.map((plugin) => plugin.handlers ?? {})) as never)
    .pipe(
      Effect.flatMap((handlers) => Effect.provide(toolkit, handlers)),
      Effect.map((handlers): ApprovalToolkit => {
        const handle = handlers.handle as Toolkit.WithHandler<Record<string, Tool.Any>>["handle"];
        const wrappedHandle = ((name: string, params: unknown) =>
          semaphore.withPermit(
            Effect.gen(function* () {
              // The whole Tool call runs in the owning Plugin's context: the handler
              // itself plus any schema decode/encode services from its resource.
              const owner = owners.get(name);
              const tool = handlers.tools[name] as Tool.Any;
              let prepared = preparedByKey.get(keyFor(name, params))?.shift();
              if (prepared === undefined) {
                const decodedParams = yield* providePlugin(
                  owner,
                  contexts,
                  Schema.decodeUnknownEffect(tool.parametersSchema)(params),
                ).pipe(
                  // handlers.handle owns parameter failures; this decode only retries the prepared lookup.
                  Effect.orElseSucceed(() => params),
                );
                prepared = preparedByKey.get(keyFor(name, decodedParams))?.shift();
              }
              if (prepared !== undefined) preparedByCallId.delete(prepared.toolCallId);
              const veto =
                prepared === undefined
                  ? yield* runPreTool(name, params).pipe(
                      hookAiError("preTool", "Pre-Tool Hook failed"),
                    )
                  : prepared._tag === "ok"
                    ? prepared.veto
                    : undefined;
              if (veto !== undefined) return Stream.succeed(failureResult(veto));

              const results = yield* providePlugin(
                owner,
                contexts,
                handle(name, params).pipe(
                  Effect.flatMap((stream) =>
                    Stream.runCollect(
                      stream as unknown as Stream.Stream<Tool.HandlerResult<Tool.Any>, unknown>,
                    ),
                  ),
                ),
              ).pipe(toolAiError(name));
              if (!plugins.some((plugin) => plugin.hooks?.postTool !== undefined)) {
                return Stream.fromIterable(results);
              }
              const validator = validators[name];
              const finalResults = yield* Effect.forEach(results, (handlerResult) =>
                Effect.gen(function* () {
                  // Schema-less dynamic Tool failures are already encoded and have no failure schema.
                  if (
                    handlerResult.isFailure &&
                    (validator !== undefined ||
                      (Tool.isDynamic(tool) && tool.failureSchema === Schema.Never))
                  ) {
                    return handlerResult;
                  }

                  let result = handlerResult.result;
                  for (const plugin of plugins) {
                    const postTool = plugin.hooks?.postTool;
                    if (postTool !== undefined) {
                      result = yield* providePlugin(
                        plugin,
                        contexts,
                        postTool({
                          name,
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
                    validateResult(tool, handlerResult, result, validator),
                  ).pipe(hookAiError("postTool", "Post-Tool result validation failed"));
                }),
              );
              return Stream.fromIterable(finalResults);
            }),
          )) as Toolkit.WithHandler<Record<string, Tool.Any>>["handle"];
        return {
          toolkit: { tools: handlers.tools, handle: wrappedHandle },
          approvalOutcome: (toolCallId) => {
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
          },
          clearPrepared: () => {
            preparedByKey.clear();
            preparedByCallId.clear();
          },
        };
      }),
    );
};
