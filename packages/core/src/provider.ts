import { Context, Effect, Layer, Option, Predicate, Schema } from "effect";
import { LanguageModel } from "effect/ai";
import { StepProtocolError } from "./session/errors.js";
import { ModelRequestAccounting } from "./session/step.js";
import { CredentialDescriptorSchema } from "./credential.js";
import type { CredentialDescriptor } from "./credential.js";

// Module-private runtime brand complements WeakMap metadata with compile-time Provider identity.
const ProviderTypeId: unique symbol = Symbol("@mitome/core/Provider");
declare const ProvisionTypeId: unique symbol;

/**
 * A configured model Provider with non-secret catalog hints. `E` and `R` are the error and
 * requirements of provisioning one of its Models, carried only in the type.
 */
export interface Provider<
  Id extends string = string,
  ModelIds extends ReadonlyArray<string> = ReadonlyArray<string>,
  E = never,
  R = never,
> {
  /** @internal */
  readonly [ProviderTypeId]: typeof ProviderTypeId;
  /** @internal Type-only record of the provisioning error and requirements; never set. */
  readonly [ProvisionTypeId]?: { readonly error: E; readonly requirements: R };
  readonly id: Id;
  readonly modelIds: ModelIds;
}

/**
 * Any configured Provider, whatever its catalog, provisioning error or requirements: what
 * declaration, catalog and authentication code holds. It does not claim the Provider provisions
 * without further requirements; only a Provider's own static type can say that.
 */
export type AnyProvider = Provider<string, ReadonlyArray<string>, unknown, unknown>;

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
  Value extends Provider<infer Id, infer ModelIds, infer _E, infer _R>
    ? `${Id}/${ModelIds[number] | (string & {})}`
    : never;

/** Non-secret facts a Provider knows about one Provider-native Model id. */
export interface ModelMetadata {
  /** Context window in tokens, as the Provider reports it; hints, not an entitlement check. */
  readonly contextWindow: number;
}

/** Per-Model metadata keyed by Provider-native Model id; ids without an entry stay unknown. */
export type ModelMetadataMap = { readonly [modelId: string]: ModelMetadata };

interface ProviderMetadata<E, R> {
  readonly credential: CredentialDescriptor | undefined;
  readonly provision: (modelId: string) => Layer.Layer<LanguageModel.LanguageModel, E, R>;
  readonly models: ModelMetadataMap;
}

const providerMetadata = new WeakMap<object, ProviderMetadata<unknown, unknown>>();

/**
 * Creates a configured Provider without exposing credentials or provisioning behavior. The
 * Provider's type keeps its provisioning Layer's error and requirements; provisioning stays lazy.
 */
export const makeProvider = <
  const Id extends string,
  const ModelIds extends ReadonlyArray<string>,
  E = never,
  R = never,
>(
  id: ValidProviderId<Id>,
  modelIds: ModelIds,
  credential: CredentialDescriptor | undefined,
  provision: (modelId: string) => Layer.Layer<LanguageModel.LanguageModel, E, R>,
  models: ModelMetadataMap = {},
): Provider<Id, ModelIds, E, R> => {
  // Runtime checks because Provider factories may forward an id typed as plain string.
  if (id.length === 0 || id.includes("/")) {
    throw new TypeError("Provider id must be non-empty and contain no '/'");
  }
  if (Predicate.isString(credential) && !Schema.is(CredentialDescriptorSchema)(credential)) {
    throw new TypeError("Provider credential must be a valid environment variable name");
  }

  const provider: Provider<Id, ModelIds, E, R> = {
    [ProviderTypeId]: ProviderTypeId,
    id,
    modelIds,
  };
  Object.defineProperty(provider, ProviderTypeId, { enumerable: false });
  providerMetadata.set(provider, { credential, provision, models });
  return provider;
};

/**
 * Whether a value is a Provider created by this copy of Core. The brand establishes only that: the
 * narrowed Provider's provisioning error and requirements stay unknown, so it cannot be provisioned
 * as if it needed nothing further.
 */
export const isProvider = (value: NonNullable<typeof Schema.Unknown.Type>): value is AnyProvider =>
  providerMetadata.has(value);

/**
 * Core-internal access to a Provider's hidden metadata, typed by the Provider's own provisioning
 * error and requirements; absent for Providers Core did not create.
 */
export const getProviderMetadata = <E, R>(
  provider: Provider<string, ReadonlyArray<string>, E, R>,
): ProviderMetadata<E, R> | undefined =>
  // SAFETY: makeProvider stores each Provider's metadata with the provision function that fixed
  // that Provider's E and R, so the entry for this value has exactly these types.
  providerMetadata.get(provider) as ProviderMetadata<E, R> | undefined;

/**
 * The Model binding a Provider provisions for one Provider-native Model id, built only when the
 * Layer is, with the Provider's provisioning error and requirements. It deliberately exposes only
 * the Model and its request accounting, not other services the provisioning Layer builds. It fails before any Model
 * request unless the binding declares request accounting for the exact Model it builds, so it can
 * serve controlled Steps. This neither parses Qualified Model ids nor applies defaults; selection
 * belongs to the composing application.
 */
export const providerModel = <E, R>(
  provider: Provider<string, ReadonlyArray<string>, E, R>,
  modelId: string,
): Layer.Layer<LanguageModel.LanguageModel | ModelRequestAccounting, E | StepProtocolError, R> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const metadata = getProviderMetadata(provider);
      if (metadata === undefined) {
        return yield* Effect.die(new TypeError("Provider was not created by this copy of Core"));
      }
      const context = yield* Layer.build(metadata.provision(modelId));
      const model = Context.get(context, LanguageModel.LanguageModel);
      const accounting = Context.getOption(context, ModelRequestAccounting);
      if (Option.isNone(accounting) || accounting.value.model !== model) {
        return yield* new StepProtocolError({
          reason: "unsupported-accounting",
          detail: `Provider "${provider.id}" does not account for requests of Model "${modelId}"`,
        });
      }
      return Context.add(context, ModelRequestAccounting, accounting.value);
    }),
  );

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
