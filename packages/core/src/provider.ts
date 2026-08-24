import { Layer, Predicate, Schema } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import type { CredentialDescriptor } from "./credential.js";

// Module-private runtime brand complements WeakMap metadata with compile-time Provider identity.
const ProviderTypeId: unique symbol = Symbol("@mitome/core/Provider");

/** A configured model Provider with non-secret catalog hints. */
export interface Provider<
  Id extends string = string,
  ModelIds extends ReadonlyArray<string> = ReadonlyArray<string>,
> {
  readonly [ProviderTypeId]: typeof ProviderTypeId;
  readonly id: Id;
  readonly modelIds: ModelIds;
}

/** Any configured Provider, for code that holds Providers without knowing their catalog. */
export type AnyProvider = Provider<string, ReadonlyArray<string>>;

/**
 * Constrains a Provider id literal so it can form a Qualified Model id.
 *
 * Shaped as an intersection rather than a bare conditional so it stays idempotent:
 * `Id & ValidProviderId<Id>` collapses back to `ValidProviderId<Id>`, which is what lets
 * wrapper factories forward an unresolved `Id` into `makeProvider`.
 */
export type ValidProviderId<Id extends string> = Id &
  (Id extends "" | `${string}/${string}` ? never : unknown);

/** A Provider-qualified Model id, written as `provider/model`. */
export type QualifiedModelId<Value extends AnyProvider> =
  Value extends Provider<infer Id, infer ModelIds>
    ? `${Id}/${ModelIds[number] | (string & {})}`
    : never;

interface ProviderMetadata {
  readonly credential: CredentialDescriptor | undefined;
  readonly provision: (modelId: string) => Layer.Layer<LanguageModel.LanguageModel, unknown, never>;
}

const providerMetadata = new WeakMap<object, ProviderMetadata>();

/** Creates a configured Provider without exposing credentials or provisioning behavior. */
export const makeProvider = <const Id extends string, const ModelIds extends ReadonlyArray<string>>(
  id: ValidProviderId<Id>,
  modelIds: ModelIds,
  credential: CredentialDescriptor | undefined,
  provision: (modelId: string) => Layer.Layer<LanguageModel.LanguageModel, unknown, never>,
): Provider<Id, ModelIds> => {
  // Runtime checks because Provider factories may forward an id typed as plain string.
  if (id.length === 0 || id.includes("/")) {
    throw new TypeError("Provider id must be non-empty and contain no '/'");
  }
  if (Predicate.isString(credential) && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(credential)) {
    throw new TypeError("Provider credential must be a valid environment variable name");
  }

  const provider: Provider<Id, ModelIds> = { [ProviderTypeId]: ProviderTypeId, id, modelIds };
  Object.defineProperty(provider, ProviderTypeId, { enumerable: false });
  providerMetadata.set(provider, { credential, provision });
  return provider;
};

/** Whether a value is a Provider created by this copy of Core. */
export const isProvider = (value: NonNullable<typeof Schema.Unknown.Type>): value is AnyProvider =>
  providerMetadata.has(value);

/** Core-internal access to a Provider's hidden metadata; absent for Providers Core did not create. */
export const getProviderMetadata = (provider: AnyProvider): ProviderMetadata | undefined =>
  providerMetadata.get(provider);

/** Returns a Provider's declarative Credential metadata without provisioning a Model. */
export const credentialDescriptor = (provider: AnyProvider): CredentialDescriptor | undefined =>
  providerMetadata.get(provider)?.credential;

/**
 * Splits a Qualified Model id at its first `/`, leaving later `/` characters in the
 * Provider-native Model id. Returns undefined for anything that cannot select a Model.
 */
export const parseQualifiedModelId = (
  qualifiedModelId: typeof Schema.Unknown.Type,
): { readonly providerId: string; readonly modelId: string } | undefined => {
  if (!Predicate.isString(qualifiedModelId)) return undefined;
  const separator = qualifiedModelId.indexOf("/");
  if (separator <= 0 || separator === qualifiedModelId.length - 1) return undefined;
  return {
    providerId: qualifiedModelId.slice(0, separator),
    modelId: qualifiedModelId.slice(separator + 1),
  };
};
