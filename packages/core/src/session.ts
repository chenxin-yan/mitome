import { Context, Effect, Layer, Schema, Scope, Semaphore, Stream } from "effect";
import { AiError, LanguageModel, Prompt, Tool, Toolkit } from "effect/unstable/ai";
import type { Response } from "effect/unstable/ai";
import { validateDefinition } from "./definition.js";
import type { Definition, DefinitionError, Plugin, ToolResultValidator } from "./definition.js";
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

const transformPrompt = (
  plugins: ReadonlyArray<Plugin>,
  prompt: Prompt.Prompt,
): Effect.Effect<Prompt.Prompt, unknown> =>
  Effect.gen(function* () {
    let current = prompt;
    for (const plugin of plugins) {
      current = yield* plugin.hooks?.preStep?.(current) ?? Effect.succeed(current);
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

const makeToolkit = (
  plugins: ReadonlyArray<Plugin>,
  semaphore: Semaphore.Semaphore,
): Effect.Effect<Toolkit.WithHandler<Record<string, Tool.Any>>, never> => {
  const tools = plugins.flatMap((plugin) => Object.values(plugin.toolkit?.tools ?? {}));
  const validators: Readonly<Record<string, ToolResultValidator>> = Object.assign(
    {},
    ...plugins.map((plugin) => plugin.toolResultValidators ?? {}),
  );
  const toolkit = Toolkit.make(...tools);
  return toolkit
    .toHandlers(Object.assign({}, ...plugins.map((plugin) => plugin.handlers ?? {})) as never)
    .pipe(
      Effect.flatMap((handlers) => Effect.provide(toolkit, handlers)),
      Effect.map((handlers): Toolkit.WithHandler<Record<string, Tool.Any>> => {
        const handle = handlers.handle as Toolkit.WithHandler<Record<string, Tool.Any>>["handle"];
        const wrappedHandle = ((name: string, params: unknown) =>
          semaphore.withPermit(
            Effect.gen(function* () {
              for (const plugin of plugins) {
                const veto = yield* (plugin.hooks?.preTool?.({ name, params }) ?? Effect.void).pipe(
                  hookAiError("preTool", "Pre-Tool Hook failed"),
                );
                if (veto !== undefined) return Stream.succeed(failureResult(veto.reason));
              }

              const results = yield* handle(name, params).pipe(
                Effect.flatMap((stream) =>
                  Stream.runCollect(
                    stream as unknown as Stream.Stream<Tool.HandlerResult<Tool.Any>, unknown>,
                  ),
                ),
                toolAiError(name),
              );
              if (!plugins.some((plugin) => plugin.hooks?.postTool !== undefined)) {
                return Stream.fromIterable(results);
              }
              const tool = handlers.tools[name] as Tool.Any;
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
                      result = yield* postTool({
                        name,
                        params,
                        result,
                        isFailure: handlerResult.isFailure,
                      }).pipe(hookAiError("postTool", "Post-Tool Hook failed"));
                    }
                  }
                  return yield* validateResult(tool, handlerResult, result, validator).pipe(
                    hookAiError("postTool", "Post-Tool result validation failed"),
                  );
                }),
              );
              return Stream.fromIterable(finalResults);
            }),
          )) as Toolkit.WithHandler<Record<string, Tool.Any>>["handle"];
        return { tools: handlers.tools, handle: wrappedHandle };
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
  plugins: ReadonlyArray<Plugin>,
  getHook: (plugin: Plugin) => Effect.Effect<void, unknown> | undefined,
  message: string,
): Effect.Effect<void> =>
  Effect.forEach(
    plugins,
    (plugin) => (getHook(plugin) ?? Effect.void).pipe(logHookFailure(message)),
    { discard: true },
  );

const runStartHooks = (
  plugins: ReadonlyArray<Plugin>,
  getStart: (plugin: Plugin) => Effect.Effect<void, unknown> | undefined,
  getEnd: (plugin: Plugin) => Effect.Effect<void, unknown> | undefined,
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
  plugins: ReadonlyArray<Plugin>,
  getHook: (plugin: Plugin) => Effect.Effect<void, unknown> | undefined,
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

  const context = yield* Layer.build(layer);
  const model = Context.get(context, LanguageModel.LanguageModel);
  const semaphore = yield* Semaphore.make(1);
  const toolkit = yield* makeToolkit(definition.plugins, semaphore);
  let history = Prompt.make([{ role: "system", content: definition.instructions }]);
  let isReleased = false;
  let isTurnActive = false;

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      history = Prompt.empty;
      isReleased = true;
    }),
  );

  yield* runStartHooks(
    definition.plugins,
    (plugin) => plugin.hooks?.sessionStart,
    (plugin) => plugin.hooks?.sessionEnd,
    "Session end Hook failed",
  ).pipe(hookTurnError("Session start Hook failed"));

  yield* Effect.addFinalizer(() =>
    // A failing sessionEnd Hook must not fail scope close or skip later cleanup.
    runCleanupHooks(
      definition.plugins,
      (plugin) => plugin.hooks?.sessionEnd,
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
    return Stream.unwrap(
      runStartHooks(
        definition.plugins,
        (plugin) => plugin.hooks?.stepStart?.(prompt),
        (plugin) => plugin.hooks?.stepEnd?.(prompt),
        "Step end Hook failed",
      ).pipe(
        hookTurnError("Step start Hook failed"),
        Effect.map(() => {
          const startedPlugins = definition.plugins;
          const endProgress: HookProgress = { dispatched: 0 };
          let endPrompt = prompt;
          return Stream.unwrap(
            transformPrompt(definition.plugins, prompt).pipe(
              hookTurnError("Pre-Step Hook failed"),
              Effect.map((transformed) => {
                endPrompt = transformed;
                return (
                  model.streamText({ prompt: transformed, toolkit }) as Stream.Stream<
                    Response.StreamPart<Record<string, Tool.Any>>,
                    unknown
                  >
                ).pipe(
                  Stream.mapError(modelTurnError),
                  Stream.tap((part) => Effect.sync(() => parts.push(part))),
                  Stream.filter(
                    (part) =>
                      part.type === "text-delta" ||
                      part.type === "tool-call" ||
                      part.type === "tool-result",
                  ),
                  Stream.map((part): StepEvent => {
                    if (part.type === "text-delta") {
                      return { type: "model-output", text: part.delta };
                    }
                    if (part.type === "tool-call") {
                      return { type: "tool-call", id: part.id, name: part.name };
                    }
                    return {
                      type: "tool-result",
                      id: part.id,
                      name: part.name,
                      result: part.result,
                      isFailure: part.isFailure,
                    };
                  }),
                  Stream.concat(
                    Stream.suspend(() => {
                      const nextPrompt = Prompt.concat(prompt, Prompt.fromResponseParts(parts));
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
                            (plugin) => plugin.hooks?.stepEnd?.(transformed),
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
                (plugin) => plugin.hooks?.stepEnd?.(endPrompt),
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
            (plugin) => plugin.hooks?.turnStart?.(text),
            (plugin) => plugin.hooks?.turnEnd?.(text),
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
                    (plugin) => plugin.hooks?.turnEnd?.(text),
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
                    (plugin) => plugin.hooks?.turnEnd?.(text),
                    "Turn end Hook failed",
                  ),
                ),
              );
            }),
          ),
        ).pipe(
          Stream.ensuring(
            Effect.sync(() => {
              isTurnActive = false;
            }),
          ),
        );
      }),
    history: () => history.content,
    released: () => isReleased,
  };
});
