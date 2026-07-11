import { Context, Effect, Layer, Scope, Stream } from "effect";
import { LanguageModel } from "effect/unstable/ai";

const ModelTypeId: unique symbol = Symbol.for("@mitome/core/Model");

/** An opaque, provider-provisioned model value. */
export interface Model {
  readonly [ModelTypeId]: typeof ModelTypeId;
}

export interface Plugin {
  readonly name: string;
}

export interface Definition {
  readonly instructions: string;
  readonly model: Model;
  readonly plugins: ReadonlyArray<Plugin>;
}

export type TurnEvent =
  | { readonly type: "model-output"; readonly text: string }
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
  readonly history: () => ReadonlyArray<string>;
  readonly released: () => boolean;
}

const modelLayers = new WeakMap<Model, Layer.Layer<LanguageModel.LanguageModel, never, never>>();

/** Creates the canonical Model value from its provisioned Effect model layer. */
export const makeModel = (layer: Layer.Layer<LanguageModel.LanguageModel, never, never>): Model => {
  const model = { [ModelTypeId]: ModelTypeId } as Model;
  modelLayers.set(model, layer);
  return model;
};

export const createSession = (definition: Definition): Effect.Effect<Session, never, Scope.Scope> =>
  Effect.gen(function* () {
    const layer = modelLayers.get(definition.model);
    if (layer === undefined) {
      return yield* Effect.die(new Error("Model was not created by @mitome/core"));
    }

    const context = yield* Layer.build(layer);
    const model = Context.get(context, LanguageModel.LanguageModel);
    const history: Array<string> = [];
    let isReleased = false;
    let isTurnActive = false;

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        history.length = 0;
        isReleased = true;
      }),
    );

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
          history.push(text);
          return model.streamText({ prompt: `${definition.instructions}\n${text}` }).pipe(
            Stream.filter((part) => part.type === "text-delta"),
            Stream.map((part): TurnEvent => ({ type: "model-output", text: part.delta })),
            Stream.concat(Stream.succeed<TurnEvent>({ type: "response-complete" })),
            Stream.ensuring(
              Effect.sync(() => {
                isTurnActive = false;
              }),
            ),
          );
        }),
      history: () => history,
      released: () => isReleased,
    };
  });
