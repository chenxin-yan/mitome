import { Layer } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import type { CredentialDescriptor } from "./model.js";

// Type-only so Provider values expose no runtime brand; the WeakMap enforces Core identity.
declare const ProviderTypeId: unique symbol;

/** A configured model Provider with non-secret catalog hints. */
export interface Provider<
  Id extends string = string,
  ModelIds extends ReadonlyArray<string> = ReadonlyArray<string>,
> {
  readonly [ProviderTypeId]: typeof ProviderTypeId;
  readonly id: Id;
  readonly modelIds: ModelIds;
}

export type AnyProvider = Provider<string, ReadonlyArray<string>>;

/** A Provider-qualified Model identifier. */
export type ModelIdentifier<Value extends AnyProvider> =
  Value extends Provider<infer Id, infer ModelIds>
    ? `${Id}/${ModelIds[number] | (string & {})}`
    : never;

interface ProviderMetadata {
  readonly credential: CredentialDescriptor | undefined;
  readonly provision: (modelId: string) => Layer.Layer<LanguageModel.LanguageModel, unknown, never>;
}

const providerMetadata = new WeakMap<AnyProvider, ProviderMetadata>();

/** Creates a configured Provider without exposing credentials or provisioning behavior. */
export const makeProvider = <const Id extends string, const ModelIds extends ReadonlyArray<string>>(
  id: Id & (Id extends "" | `${string}/${string}` ? never : unknown),
  modelIds: ModelIds,
  credential: CredentialDescriptor | undefined,
  provision: (modelId: string) => Layer.Layer<LanguageModel.LanguageModel, unknown, never>,
): Provider<Id, ModelIds> => {
  if (id.length === 0 || id.includes("/")) {
    throw new TypeError("Provider id must be non-empty and contain no '/'");
  }

  const provider = { id: id as Id, modelIds } as Provider<Id, ModelIds>;
  providerMetadata.set(provider, { credential, provision });
  return provider;
};

export const getProviderMetadata = (provider: AnyProvider): ProviderMetadata | undefined =>
  providerMetadata.get(provider);

export interface ParsedModelIdentifier {
  readonly providerId: string;
  readonly modelId: string;
}

export const parseModelIdentifier = (identifier: unknown): ParsedModelIdentifier | undefined => {
  if (typeof identifier !== "string") return undefined;
  const separator = identifier.indexOf("/");
  if (separator <= 0 || separator === identifier.length - 1) return undefined;
  return {
    providerId: identifier.slice(0, separator),
    modelId: identifier.slice(separator + 1),
  };
};
