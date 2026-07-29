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
  readonly resolve: (qualifiedModelId: unknown) => Effect.Effect<RuntimeModel, TurnError>;
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

  return {
    resolve: (qualifiedModelId) => {
      const parsed = parseQualifiedModelId(qualifiedModelId);
      if (parsed === undefined) {
        return Effect.fail(
          new TurnError({
            message: `Malformed Qualified Model id: ${String(qualifiedModelId)}`,
            cause: qualifiedModelId,
          }),
        );
      }
      const provider = providers.get(parsed.providerId);
      if (provider === undefined) {
        return Effect.fail(
          new TurnError({
            message: `Unregistered Provider id: ${parsed.providerId}`,
            cause: qualifiedModelId,
          }),
        );
      }

      // parseQualifiedModelId only succeeds for strings.
      const cacheKey = qualifiedModelId as string;
      const cached = models.get(cacheKey);
      if (cached !== undefined) return Effect.succeed(cached);

      const metadata = getProviderMetadata(provider)!;
      return Effect.try({
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
          models.set(cacheKey, selected);
          return selected;
        }),
      );
    },
  };
};
