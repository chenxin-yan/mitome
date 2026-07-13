import { Context, Effect, Layer, Schema, Scope, Semaphore, Stream } from "effect";
import { LanguageModel, Prompt, Toolkit } from "effect/unstable/ai";
import type { Response, Tool } from "effect/unstable/ai";
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

/** A model or Tool stream failed while completing a Turn. */
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
              handle(name, params).pipe(
                Effect.flatMap((results) =>
                  Stream.runCollect(results as Stream.Stream<Tool.HandlerResult<Tool.Any>>),
                ),
                Effect.map((values) => Stream.fromIterable(values)),
              ),
            ),
        };
      }),
    );
};

export const createSession: (
  definition: Definition,
) => Effect.Effect<Session, DefinitionError, Scope.Scope> = Effect.fn("@mitome/core/createSession")(
  function* (definition) {
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
      return (
        model.streamText({ prompt, toolkit }) as Stream.Stream<
          Response.StreamPart<Record<string, Tool.Any>>,
          unknown
        >
      ).pipe(
        Stream.mapError((cause) => new TurnError({ message: "Turn failed", cause })),
        Stream.tap((part) => Effect.sync(() => parts.push(part))),
        Stream.filter(
          (part) =>
            part.type === "text-delta" || part.type === "tool-call" || part.type === "tool-result",
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
            return parts.some((part) => part.type === "tool-call" && part.providerExecuted !== true)
              ? runStep(nextPrompt, step + 1)
              : Stream.fromEffect(
                  Effect.sync(() => {
                    history = nextPrompt;
                    return { type: "response-complete" } as const;
                  }),
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
          return runStep(Prompt.concat(history, text), 0).pipe(
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
  },
);
