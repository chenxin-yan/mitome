import { Context, Effect, Layer } from "effect";
import type { Scope } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { getProviderMetadata, parseQualifiedModelId } from "../provider.js";
import type { AnyProvider } from "../provider.js";
import { TurnError } from "./errors.js";

/** One Model selected for a Turn, with identity and Provider-declared facts alongside its service. */
export interface RuntimeModel {
  /** Qualified Model id the Turn selected. */
  readonly id: string;
  readonly providerId: string;
  /** Provider-native Model id after the first `/`. */
  readonly modelId: string;
  /** Provider metadata; undefined when the Provider declares no window for this Model id. */
  readonly contextWindow: number | undefined;
  readonly context: Context.Context<LanguageModel.LanguageModel>;
  readonly model: LanguageModel.LanguageModel;
}

const modelSetupTurnError = (cause: unknown) =>
  new TurnError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

export const makeModelResolver = (
  providers: ReadonlyMap<string, AnyProvider>,
  scope: Scope.Scope,
): ((qualifiedModelId: string) => Effect.Effect<RuntimeModel, TurnError>) => {
  const models = new Map<string, RuntimeModel>();

  const resolve = Effect.fn("@mitome/core/ModelResolver.resolve")(function* (
    qualifiedModelId: string,
  ) {
    const parsed = parseQualifiedModelId(qualifiedModelId);
    if (parsed === undefined) {
      return yield* new TurnError({
        message: `Malformed Qualified Model id: ${String(qualifiedModelId)}`,
        cause: qualifiedModelId,
      });
    }
    const provider = providers.get(parsed.providerId);
    if (provider === undefined) {
      return yield* new TurnError({
        message: `Unregistered Provider id: ${parsed.providerId}`,
        cause: qualifiedModelId,
      });
    }

    const cached = models.get(qualifiedModelId);
    if (cached !== undefined) return cached;

    // SAFETY: compileAgentDefinition rejects providers without Core metadata before creating a Session.
    const metadata = getProviderMetadata(provider)!;
    return yield* Effect.try({
      try: () => metadata.provision(parsed.modelId),
      catch: modelSetupTurnError,
    }).pipe(
      Effect.flatMap((layer) =>
        Layer.buildWithScope(layer, scope).pipe(Effect.mapError(modelSetupTurnError)),
      ),
      Effect.map((context) => {
        const selected: RuntimeModel = {
          id: qualifiedModelId,
          providerId: parsed.providerId,
          modelId: parsed.modelId,
          contextWindow: metadata.models[parsed.modelId]?.contextWindow,
          context,
          model: Context.get(context, LanguageModel.LanguageModel),
        };
        models.set(qualifiedModelId, selected);
        return selected;
      }),
    );
  });

  return resolve;
};
