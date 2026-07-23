import { Layer } from "effect";
import { LanguageModel } from "effect/unstable/ai";

const ModelTypeId: unique symbol = Symbol.for("@mitome/core/Model");

/** An opaque, provider-provisioned model value. */
export interface Model {
  readonly [ModelTypeId]: typeof ModelTypeId;
}

/**
 * Provider-owned credential metadata available without starting a Session: an
 * environment variable name, or a reference to an OAuth capability module.
 */
export type CredentialDescriptor = string | { readonly capability: { readonly module: string } };

/**
 * Host-facing options a Host passes to an Auth capability's `authenticate`.
 * Not used when authoring Agent Definitions.
 */
export interface AuthenticateOptions {
  readonly operation: "login" | "logout";
  readonly configDirectory: string;
  readonly input: () => Promise<string | undefined>;
  readonly output: (text: string) => void;
  readonly openBrowser?: false;
}

/**
 * Host-facing contract of the Auth capability module a Credential descriptor
 * names: implemented by a Provider, invoked by Hosts to run interactive login
 * or logout. Promise-based because capability modules load in plain child
 * processes outside any Effect runtime. Not used when authoring Agent
 * Definitions.
 */
export interface AuthCapability {
  readonly authenticate: (options: AuthenticateOptions) => Promise<void>;
}

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

/** Returns the Model's credential descriptor (env var name or OAuth capability) without constructing the provider Layer. */
export const credentialDescriptor = (model: Model): CredentialDescriptor | undefined =>
  modelCredentials.get(model);

export const getModelLayer = (
  model: Model,
): Layer.Layer<LanguageModel.LanguageModel, unknown, never> | undefined => modelLayers.get(model);
