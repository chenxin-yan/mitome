import { Context, Effect, Layer, Scope, Semaphore, Stream } from "effect";
import { LanguageModel, Prompt, Toolkit } from "effect/unstable/ai";
import type { Tool } from "effect/unstable/ai";

const ModelTypeId: unique symbol = Symbol.for("@mitome/core/Model");

/** An opaque, provider-provisioned model value. */
export interface Model {
  readonly [ModelTypeId]: typeof ModelTypeId;
}

export interface Plugin {
  readonly name: string;
  readonly toolkit?: Toolkit.Any;
  readonly handlers?: Record<string, (params: unknown) => Effect.Effect<unknown, unknown>>;
}

export interface Definition {
  readonly instructions: string;
  readonly model: Model;
  readonly plugins: ReadonlyArray<Plugin>;
}

export class DefinitionError extends Error {
  readonly _tag = "DefinitionError";
}

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

/** Overlapping `Session.prompt()` while a Turn is active; ADR-0003 mandates a typed busy failure. */
export class SessionBusyError extends Error {
  readonly _tag = "SessionBusyError" as const;
  constructor() {
    super("Session is busy with an active Turn");
  }
}

/** Prompt on a Session whose scope has already closed; the provider resources are disposed. */
export class SessionReleasedError extends Error {
  readonly _tag = "SessionReleasedError" as const;
  constructor() {
    super("Session scope has been released");
  }
}

export interface Session {
  readonly prompt: (text: string) => Stream.Stream<TurnEvent, unknown>;
  readonly history: () => ReadonlyArray<Prompt.Message>;
  readonly released: () => boolean;
}

const modelLayers = new WeakMap<Model, Layer.Layer<LanguageModel.LanguageModel, never, never>>();

/** Creates the canonical Model value from its provisioned Effect model layer. */
export const makeModel = (layer: Layer.Layer<LanguageModel.LanguageModel, never, never>): Model => {
  const model = { [ModelTypeId]: ModelTypeId } as Model;
  modelLayers.set(model, layer);
  return model;
};

export const validateDefinition = (definition: Definition): void => {
  const pluginNames = new Set<string>();
  const toolNames = new Set<string>();

  for (const plugin of definition.plugins) {
    if (pluginNames.has(plugin.name)) {
      throw new DefinitionError(`Duplicate Plugin name: ${plugin.name}`);
    }
    pluginNames.add(plugin.name);

    // Effect Toolkits are name-keyed, so duplicate core-native Tools are already collapsed by Effect.
    for (const tool of Object.values(plugin.toolkit?.tools ?? {})) {
      if (toolNames.has(tool.name)) {
        throw new DefinitionError(`Duplicate Tool name: ${tool.name}`);
      }
      toolNames.add(tool.name);
    }
  }
};

const makeToolkit = (
  plugins: ReadonlyArray<Plugin>,
  semaphore: Semaphore.Semaphore,
): Effect.Effect<Toolkit.WithHandler<Record<string, Tool.Any>>, never> => {
  const tools = plugins.flatMap((plugin) => Object.values(plugin.toolkit?.tools ?? {}));
  const toolkit = Toolkit.make(...tools);
  const resolved = toolkit
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
  return resolved;
};

export const createSession = (
  definition: Definition,
): Effect.Effect<Session, never, Scope.Scope> => {
  validateDefinition(definition);

  return Effect.gen(function* () {
    const layer = modelLayers.get(definition.model);
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

    const runStep = (prompt: Prompt.Prompt): Stream.Stream<TurnEvent, unknown> => {
      const parts: Array<import("effect/unstable/ai/Response").AnyPart> = [];
      return (
        model.streamText({ prompt, toolkit }) as Stream.Stream<
          import("effect/unstable/ai/Response").StreamPart<Record<string, Tool.Any>>,
          unknown
        >
      ).pipe(
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
            history = Prompt.concat(prompt, Prompt.fromResponseParts(parts));
            return parts.some((part) => part.type === "tool-call")
              ? runStep(history)
              : Stream.succeed<TurnEvent>({ type: "response-complete" });
          }),
        ),
      );
    };

    return {
      prompt: (text) =>
        Stream.suspend((): Stream.Stream<TurnEvent, unknown> => {
          if (isReleased) {
            return Stream.fail(new SessionReleasedError());
          }
          if (isTurnActive) {
            return Stream.fail(new SessionBusyError());
          }
          isTurnActive = true;
          return runStep(Prompt.concat(history, text)).pipe(
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
};
