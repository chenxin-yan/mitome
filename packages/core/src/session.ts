import { Context, Effect, Exit, Layer, Schema, Scope, Semaphore, Stream } from "effect";
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/unstable/ai";
import type { Response } from "effect/unstable/ai";
import { validateDefinition } from "./definition.js";
import type { Definition, DefinitionError, Plugin } from "./definition.js";
import { getModelLayer } from "./model.js";

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

const runNotifications = (
  plugins: ReadonlyArray<Plugin>,
  hook: "sessionStart" | "sessionEnd",
): Effect.Effect<void, unknown> =>
  Effect.forEach(plugins, (plugin) => plugin.hooks?.[hook] ?? Effect.void, { discard: true });

const runTurnNotifications = (
  plugins: ReadonlyArray<Plugin>,
  hook: "turnStart" | "turnEnd",
  text: string,
): Effect.Effect<void, unknown> =>
  Effect.forEach(plugins, (plugin) => plugin.hooks?.[hook]?.(text) ?? Effect.void, {
    discard: true,
  });

const runStepNotifications = (
  plugins: ReadonlyArray<Plugin>,
  hook: "stepStart" | "stepEnd",
  prompt: Prompt.Prompt,
): Effect.Effect<void, unknown> =>
  Effect.forEach(plugins, (plugin) => plugin.hooks?.[hook]?.(prompt) ?? Effect.void, {
    discard: true,
  });

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

const ToolResultValidatorTypeId = Symbol.for("@mitome/core/ToolResultValidator");
type ToolResultValidator = (result: unknown) => Effect.Effect<unknown, unknown>;

/** @internal SDK output schemas need revalidation after core post-Tool transforms. */
export const setToolResultValidator = (tool: Tool.Any, validator: ToolResultValidator): void => {
  (tool as unknown as Record<symbol, ToolResultValidator>)[ToolResultValidatorTypeId] = validator;
};

const failureResult = (reason: string): Tool.HandlerResult<Tool.Any> => {
  const result = { type: "execution-denied", reason };
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
): Effect.Effect<Tool.HandlerResult<Tool.Any>, unknown> =>
  Effect.gen(function* () {
    // Preserve SDK Tool failures as encoded; post-Tool transforms intentionally do not apply to them.
    if (handlerResult.isFailure && Tool.isDynamic(tool) && tool.failureSchema === Schema.Never) {
      return handlerResult;
    }

    const validator = (tool as unknown as Record<symbol, ToolResultValidator | undefined>)[
      ToolResultValidatorTypeId
    ];
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

const makeToolkit = (
  plugins: ReadonlyArray<Plugin>,
  semaphore: Semaphore.Semaphore,
): Effect.Effect<Toolkit.WithHandler<Record<string, Tool.Any>>, never> => {
  const tools = plugins.flatMap((plugin) => Object.values(plugin.toolkit?.tools ?? {}));
  const toolkit = Toolkit.make(...tools);
  return toolkit
    .toHandlers(Object.assign({}, ...plugins.map((plugin) => plugin.handlers ?? {})) as never)
    .pipe(
      Effect.flatMap((handlers) => Effect.provide(toolkit, handlers)),
      Effect.map((handlers): Toolkit.WithHandler<Record<string, Tool.Any>> => {
        const handle = handlers.handle as Toolkit.WithHandler<Record<string, Tool.Any>>["handle"];
        return {
          tools: handlers.tools,
          handle: (name, params) =>
            semaphore.withPermit(
              Effect.gen(function* () {
                let veto: string | undefined;
                for (const plugin of plugins) {
                  if (veto !== undefined) break;
                  veto = (yield* plugin.hooks?.preTool?.({ name, params }) ?? Effect.void)?.reason;
                }
                if (veto !== undefined) return Stream.succeed(failureResult(veto));

                const results = yield* handle(name, params).pipe(
                  Effect.flatMap((stream) =>
                    Stream.runCollect(stream as Stream.Stream<Tool.HandlerResult<Tool.Any>>),
                  ),
                );
                const tool = handlers.tools[name] as Tool.Any;
                const finalResults = yield* Effect.forEach(results, (handlerResult) =>
                  Effect.gen(function* () {
                    let result = handlerResult.result;
                    let transformed = false;
                    for (const plugin of plugins) {
                      const postTool = plugin.hooks?.postTool;
                      if (postTool !== undefined) {
                        transformed = true;
                        result = yield* postTool({
                          name,
                          params,
                          result,
                          isFailure: handlerResult.isFailure,
                        });
                      }
                    }
                    return transformed
                      ? yield* validateResult(tool, handlerResult, result)
                      : handlerResult;
                  }),
                );
                return Stream.fromIterable(finalResults);
              }) as Effect.Effect<Stream.Stream<Tool.HandlerResult<Tool.Any>, never>, never>,
            ) as never,
        };
      }),
    );
};

const hookTurnError = (message: string) =>
  Effect.mapError((cause: unknown) => new TurnError({ message, cause }));

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
    // A failing sessionEnd Hook must not fail scope close.
    Effect.ignore(runNotifications(definition.plugins, "sessionEnd")).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          history = Prompt.empty;
          isReleased = true;
        }),
      ),
    ),
  );

  yield* runNotifications(definition.plugins, "sessionStart").pipe(
    hookTurnError("Session start Hook failed"),
  );

  const runStep = (
    prompt: Prompt.Prompt,
    step: number,
  ): Stream.Stream<TurnEvent, TurnStepLimitError | TurnError> => {
    if (step >= maximumTurnSteps) {
      return Stream.fail(
        new TurnStepLimitError({
          message: `Turn exceeded the ${maximumTurnSteps} model Step limit`,
        }),
      );
    }

    const parts: Array<Response.AnyPart> = [];
    return Stream.unwrap(
      Effect.gen(function* () {
        yield* runStepNotifications(definition.plugins, "stepStart", prompt).pipe(
          hookTurnError("Step start Hook failed"),
        );
        const transformed = yield* transformPrompt(definition.plugins, prompt).pipe(
          hookTurnError("Pre-Step Hook failed"),
        );
        let ended = false;
        const stream = (
          model.streamText({ prompt: transformed, toolkit }) as Stream.Stream<
            Response.StreamPart<Record<string, Tool.Any>>,
            unknown
          >
        ).pipe(
          Stream.mapError((cause) => new TurnError({ message: "Turn failed", cause })),
          Stream.tap((part) => Effect.sync(() => parts.push(part))),
          Stream.filter(
            (part) =>
              part.type === "text-delta" ||
              part.type === "tool-call" ||
              part.type === "tool-result",
          ),
          Stream.map((part): TurnEvent => {
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
              const next = parts.some(
                (part) => part.type === "tool-call" && part.providerExecuted !== true,
              )
                ? runStep(nextPrompt, step + 1)
                : Stream.fromEffect(
                    Effect.sync(() => {
                      history = nextPrompt;
                      return { type: "response-complete" } as const;
                    }),
                  );
              return Stream.concat(
                Stream.fromEffect(
                  Effect.sync(() => {
                    ended = true;
                  }).pipe(
                    Effect.andThen(
                      runStepNotifications(definition.plugins, "stepEnd", transformed).pipe(
                        hookTurnError("Step end Hook failed"),
                      ),
                    ),
                  ),
                ).pipe(Stream.drain),
                next,
              );
            }),
          ),
        );
        return stream.pipe(
          Stream.onExit((exit) =>
            // Preserve a prior failure or interruption while still notifying the Hook.
            Exit.isSuccess(exit) || ended
              ? Effect.void
              : Effect.ignore(runStepNotifications(definition.plugins, "stepEnd", transformed)),
          ),
        );
      }),
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
        let ended = false;
        return Stream.unwrap(
          runTurnNotifications(definition.plugins, "turnStart", text).pipe(
            hookTurnError("Turn start Hook failed"),
            Effect.map(() => runStep(Prompt.concat(history, text), 0)),
          ),
        ).pipe(
          Stream.concat(
            Stream.fromEffect(
              Effect.sync(() => {
                ended = true;
              }).pipe(
                Effect.andThen(
                  runTurnNotifications(definition.plugins, "turnEnd", text).pipe(
                    hookTurnError("Turn end Hook failed"),
                  ),
                ),
              ),
            ).pipe(Stream.drain),
          ),
          Stream.onExit((exit) =>
            // Preserve a prior failure or interruption while still notifying the Hook.
            Exit.isSuccess(exit) || ended
              ? Effect.void
              : Effect.ignore(runTurnNotifications(definition.plugins, "turnEnd", text)),
          ),
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
