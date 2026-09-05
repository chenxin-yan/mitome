import { Context, Effect, Layer } from "effect";
import type { Scope } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { getProviderMetadata, parseQualifiedModelId } from "../provider.js";
import type { AnyProvider } from "../provider.js";
import { TurnError } from "./errors.js";

export interface RuntimeModel {
  readonly context: Context.Context<LanguageModel.LanguageModel>;
  readonly model: LanguageModel.Service;
}

export interface ModelResolver {
  readonly resolve: (qualifiedModelId: string) => Effect.Effect<RuntimeModel, TurnError>;
}

const modelSetupTurnError = (cause: unknown) =>
  new TurnError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

export const makeModelResolver = (
  providers: ReadonlyMap<string, AnyProvider>,
  scope: Scope.Scope,
): ModelResolver => {
  const models = new Map<string, RuntimeModel>();

  const resolve: ModelResolver["resolve"] = Effect.fn("@mitome/core/ModelResolver.resolve")(
    function* (qualifiedModelId) {
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
          const selected = {
            context,
            model: Context.get(context, LanguageModel.LanguageModel),
          };
          models.set(qualifiedModelId, selected);
          return selected;
        }),
      );
    },
  );

  return { resolve };
};
