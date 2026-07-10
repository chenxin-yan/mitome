import { Layer } from "effect";
import { LanguageModel } from "effect/unstable/ai";

const ModelTypeId: unique symbol = Symbol.for("@mitome/core/Model");

/** An opaque, provider-provisioned model value. */
export interface Model {
  readonly [ModelTypeId]: typeof ModelTypeId;
}

/** Provider-owned credential metadata available without starting a Session. */
export type CredentialDescriptor = { readonly kind: "env"; readonly name: string };

const modelLayers = new WeakMap<Model, Layer.Layer<LanguageModel.LanguageModel, unknown, never>>();
const modelCredentials = new WeakMap<Model, CredentialDescriptor>();

/** Creates the canonical Model value from its provisioned Effect model layer. */
export const makeModel = (
  layer: Layer.Layer<LanguageModel.LanguageModel, unknown, never>,
  credential?: CredentialDescriptor,
): Model => {
  const model = { [ModelTypeId]: ModelTypeId } as Model;
  modelLayers.set(model, layer);
  if (credential !== undefined) modelCredentials.set(model, credential);
  return model;
};

/** Returns provider-owned credential metadata without constructing the provider Layer. */
export const credentialDescriptor = (model: Model): CredentialDescriptor | undefined =>
  modelCredentials.get(model);

export const getModelLayer = (
  model: Model,
): Layer.Layer<LanguageModel.LanguageModel, unknown, never> | undefined => modelLayers.get(model);
