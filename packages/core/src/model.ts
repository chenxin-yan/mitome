import { Layer } from "effect";
import { LanguageModel } from "effect/unstable/ai";

const ModelTypeId: unique symbol = Symbol.for("@mitome/core/Model");

/** An opaque, provider-provisioned model value. */
export interface Model {
  readonly [ModelTypeId]: typeof ModelTypeId;
}

const modelLayers = new WeakMap<Model, Layer.Layer<LanguageModel.LanguageModel, never, never>>();

/** Creates the canonical Model value from its provisioned Effect model layer. */
export const makeModel = (layer: Layer.Layer<LanguageModel.LanguageModel, never, never>): Model => {
  const model = { [ModelTypeId]: ModelTypeId } as Model;
  modelLayers.set(model, layer);
  return model;
};

export const getModelLayer = (
  model: Model,
): Layer.Layer<LanguageModel.LanguageModel, never, never> | undefined => modelLayers.get(model);
