import { Layer } from "effect";
import { LanguageModel } from "effect/unstable/ai";

const ModelTypeId: unique symbol = Symbol.for("@mitome/core/Model");

/** An opaque, provider-provisioned model value. */
export interface Model {
  readonly [ModelTypeId]: typeof ModelTypeId;
}

/** Provider-owned environment variable name available without starting a Session. */
export type CredentialDescriptor = string;

/** A provider credential sourced from the environment. */
export interface Credential {
  readonly name: string;
}

/** Declares the environment variable that supplies a provider credential at Session startup. */
export const env = (name: string): Credential => ({ name });

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

/** Returns the provider-owned environment variable name without constructing the provider Layer. */
export const credentialDescriptor = (model: Model): CredentialDescriptor | undefined =>
  modelCredentials.get(model);

export const getModelLayer = (
  model: Model,
): Layer.Layer<LanguageModel.LanguageModel, unknown, never> | undefined => modelLayers.get(model);
