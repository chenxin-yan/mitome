import { Context, Effect, Layer } from "effect";
import { LanguageModel } from "effect/ai";

/**
 * A Model binding's declaration that, while `model` runs a controlled generation, it calls
 * `reportModelRequest` immediately before sending each physical Provider request, including its
 * own retries and native fallback. A controlled Step requires it and refuses to generate when it
 * names a different `LanguageModel` than the one in use, so unaccounted bindings are rejected
 * before any request rather than run with unknown accounting. Build it with
 * `withModelRequestAccounting`; the declaration is the binding author's, qualified by tests.
 */
export class ModelRequestAccounting extends Context.Service<
  ModelRequestAccounting,
  {
    /** Which binding made the declaration, for diagnostics. */
    readonly binding: string;
    /** The exact Model instance whose requests are reported. */
    readonly model: LanguageModel.LanguageModel;
  }
>()("mitome/ModelRequestAccounting") {}

/**
 * Adds a `ModelRequestAccounting` declaration for the `LanguageModel` a binding Layer builds,
 * keeping every other service that Layer provides, with its error and requirements.
 */
export const withModelRequestAccounting = <ROut, E, R>(
  binding: string,
  layer: Layer.Layer<ROut | LanguageModel.LanguageModel, E, R>,
): Layer.Layer<ROut | LanguageModel.LanguageModel | ModelRequestAccounting, E, R> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const context = yield* Layer.build(layer);
      const model = Context.get(context, LanguageModel.LanguageModel);
      return Context.add(context, ModelRequestAccounting, { binding, model });
    }),
  );

/** The controlled generation in progress on this fiber, as `step` installs it. */
export const currentGeneration = Context.Reference<{ requests: number } | undefined>(
  "mitome/CurrentControlledGeneration",
  { defaultValue: () => undefined },
);

/**
 * Counts one physical Provider request against the controlled generation in progress on this
 * fiber. Outside a controlled generation it does nothing.
 */
export const reportModelRequest: Effect.Effect<void> = Effect.gen(function* () {
  const generation = yield* currentGeneration;
  if (generation !== undefined) {
    generation.requests += 1;
  }
});
