import { Context, Deferred, Effect, Layer, Schema, Scope, Semaphore, Stream } from "effect";
import { AiError, LanguageModel, Prompt, Tool, Toolkit } from "effect/unstable/ai";
import type { Response } from "effect/unstable/ai";
import { validateDefinition } from "./definition.js";
import type {
  AnyPlugin,
  Definition,
  DefinitionError,
  ToolInputValidator,
  ToolResultValidator,
} from "./definition.js";
import { getModelLayer } from "./model.js";

export const ToolExecutionDenied = Schema.Struct({
  type: Schema.Literal("execution-denied"),
  reason: Schema.String,
});
export type ToolExecutionDenied = typeof ToolExecutionDenied.Type;

export type TurnEvent =
  | { readonly type: "model-output"; readonly text: string }
  | { readonly type: "tool-call"; readonly id: string; readonly name: string }
  | {
      readonly type: "tool-result";
      readonly id: string;
      readonly name: string;
      readonly result: unknown;
      readonly isFailure: boolean;
    }
  | {
      readonly type: "approval-required";
      readonly approvalId: string;
      readonly toolCallId: string;
      readonly name: string;
      readonly params: unknown;
      readonly approve: () => Effect.Effect<void, ApprovalResolutionError>;
      readonly deny: (reason?: string) => Effect.Effect<void, ApprovalResolutionError>;
    }
  | { readonly type: "response-complete" };

/** Overlapping `Session.prompt()` while a Turn is active. */
export class SessionBusyError extends Schema.TaggedErrorClass<SessionBusyError>()(
  "SessionBusyError",
  { message: Schema.String },
) {}

/** Prompt on a Session whose scope has already closed. */
export class SessionReleasedError extends Schema.TaggedErrorClass<SessionReleasedError>()(
  "SessionReleasedError",
  { message: Schema.String },
) {}

const moduleName = "@mitome/core";
const maximumTurnSteps = 16;

/** A Turn reached ADR-0003's fixed model Step limit. */
export class TurnStepLimitError extends Schema.TaggedErrorClass<TurnStepLimitError>()(
  "TurnStepLimitError",
  { message: Schema.String },
) {}

/** A model, Tool, or Plugin Hook failed while completing a Turn. */
export class TurnError extends Schema.TaggedErrorClass<TurnError>()("TurnError", {
  message: Schema.String,
  cause: Schema.Unknown,
}) {}

export class ApprovalResolutionError extends Schema.TaggedErrorClass<ApprovalResolutionError>()(
  "ApprovalResolutionError",
  { message: Schema.String },
) {}

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

type PluginContexts = ReadonlyMap<AnyPlugin, Context.Context<any>>;

const providePlugin = <A, E>(
  plugin: AnyPlugin | undefined,
  contexts: PluginContexts,
  effect: Effect.Effect<A, E, any>,
): Effect.Effect<A, E> => {
  const context = plugin === undefined ? undefined : contexts.get(plugin);
  return (context === undefined ? effect : Effect.provide(effect, context)) as Effect.Effect<A, E>;
};

const transformPrompt = (
  plugins: ReadonlyArray<AnyPlugin>,
  contexts: PluginContexts,
  prompt: Prompt.Prompt,
): Effect.Effect<Prompt.Prompt, unknown> =>
  Effect.gen(function* () {
    let current = prompt;
    for (const plugin of plugins) {
      current = yield* providePlugin(
        plugin,
        contexts,
        plugin.hooks?.preStep?.(current) ?? Effect.succeed(current),
      );
    }
    return current;
  });

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

const describeFailure = (message: string, cause: unknown): string =>
  `${message}: ${cause instanceof Error ? cause.message : String(cause)}`;

const hookAiError = (method: string, message: string) =>
  Effect.mapError((cause: unknown) => {
    const reason = AiError.isAiError(cause)
      ? cause.reason
      : AiError.isAiErrorReason(cause)
        ? cause
        : new AiError.UnknownError({ description: describeFailure(message, cause) });
    return AiError.make({ module: moduleName, method, reason });
  });

const toolAiError = (method: string) =>
  Effect.mapError((cause: unknown) =>
    AiError.isAiError(cause)
      ? cause
      : AiError.make({
          module: moduleName,
          method,
          reason: AiError.isAiErrorReason(cause)
            ? cause
            : new AiError.UnknownError({
                description: describeFailure("Tool execution failed", cause),
              }),
        }),
  );

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

type ApprovalToolkit = {
  readonly toolkit: Toolkit.WithHandler<Record<string, Tool.Any>>;
  readonly vetoReason: (toolCallId: string) => string | undefined;
  readonly preToolFailure: (toolCallId: string) => { readonly cause: unknown } | undefined;
  readonly preparedParams: (toolCallId: string) => { readonly value: unknown } | undefined;
  readonly discardPrepared: (toolCallId: string) => void;
  readonly clearPrepared: () => void;
};

const makeToolkit = (
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
          vetoReason: (toolCallId) => {
            const prepared = preparedByCallId.get(toolCallId);
            if (prepared !== undefined && prepared._tag === "ok" && prepared.veto !== undefined) {
              discardPrepared(toolCallId);
              return prepared.veto;
            }
            return undefined;
          },
          preToolFailure: (toolCallId) => {
            const prepared = preparedByCallId.get(toolCallId);
            if (prepared !== undefined && prepared._tag === "failure") {
              discardPrepared(toolCallId);
              return { cause: prepared.hookFailure };
            }
            return undefined;
          },
          preparedParams: (toolCallId) => {
            const prepared = preparedByCallId.get(toolCallId);
            return prepared === undefined ? undefined : { value: prepared.params };
          },
          discardPrepared,
          clearPrepared: () => {
            preparedByKey.clear();
            preparedByCallId.clear();
          },
        };
      }),
    );
};

const hookTurnError = (message: string) =>
  Effect.mapError((cause: unknown) => new TurnError({ message, cause }));

const modelTurnError = (cause: unknown) =>
  new TurnError({
    message:
      AiError.isAiError(cause) && cause.module === moduleName
        ? cause.reason.message
        : "Turn failed",
    cause,
  });

const logHookFailure = (message: string) =>
  Effect.catchCause((cause) => Effect.logWarning(message, cause));

interface HookProgress {
  dispatched: number;
}

const runCleanupHooks = (
  plugins: ReadonlyArray<AnyPlugin>,
  getHook: (plugin: AnyPlugin) => Effect.Effect<void, unknown> | undefined,
  message: string,
): Effect.Effect<void> =>
  Effect.forEach(
    plugins,
    (plugin) => (getHook(plugin) ?? Effect.void).pipe(logHookFailure(message)),
    { discard: true },
  );

const runStartHooks = (
  plugins: ReadonlyArray<AnyPlugin>,
  getStart: (plugin: AnyPlugin) => Effect.Effect<void, unknown> | undefined,
  getEnd: (plugin: AnyPlugin) => Effect.Effect<void, unknown> | undefined,
  endFailureMessage: string,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    let started = 0;
    const start = Effect.gen(function* () {
      for (const plugin of plugins) {
        yield* getStart(plugin) ?? Effect.void;
        started += 1;
      }
    });
    return yield* start.pipe(
      Effect.onError(() => runCleanupHooks(plugins.slice(0, started), getEnd, endFailureMessage)),
    );
  });

const runEndHooks = (
  plugins: ReadonlyArray<AnyPlugin>,
  getHook: (plugin: AnyPlugin) => Effect.Effect<void, unknown> | undefined,
  progress: HookProgress,
  failureMessage: string,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    let failed = false;
    let firstFailure: unknown;
    for (const plugin of plugins) {
      // Interruption must continue with later cleanup, not invoke the active Hook twice.
      progress.dispatched += 1;
      const hook = getHook(plugin) ?? Effect.void;
      if (failed) {
        yield* hook.pipe(Effect.catch((failure) => Effect.logWarning(failureMessage, failure)));
      } else {
        yield* hook.pipe(
          Effect.catch((failure) =>
            Effect.sync(() => {
              failed = true;
              firstFailure = failure;
            }),
          ),
        );
      }
    }
    if (failed) return yield* Effect.fail(firstFailure);
  });

export const createSession: (
  definition: Definition,
) => Effect.Effect<Session, DefinitionError | TurnError, Scope.Scope> = Effect.fn(
  "@mitome/core/createSession",
)(function* (definition) {
  yield* validateDefinition(definition);

  const layer = getModelLayer(definition.model);
  if (layer === undefined) {
    return yield* Effect.die(new Error("Model was not created by @mitome/core"));
  }

  const context = yield* Layer.build(layer).pipe(
    Effect.mapError(
      (cause) =>
        new TurnError({
          message:
            typeof cause === "object" && cause !== null && "message" in cause
              ? String(cause.message)
              : String(cause),
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
