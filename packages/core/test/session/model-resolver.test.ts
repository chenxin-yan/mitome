import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { makeProvider } from "../../src/index.js";
import { makeModelResolver } from "../../src/session/model-resolver.js";
import { testLanguageModel } from "../support/provider.js";

const model = testLanguageModel(() => {
  throw new Error("unused");
});

describe("ModelResolver", () => {
  it.effect("translates malformed Qualified Model ids", () =>
    Effect.gen(function* () {
      const resolver = makeModelResolver(new Map(), yield* Effect.scope);

      expect(yield* Effect.flip(resolver.resolve("malformed"))).toMatchObject({
        _tag: "TurnError",
        message: "Malformed Qualified Model id: malformed",
        cause: "malformed",
      });
    }),
  );

  it.effect("translates unregistered Providers", () =>
    Effect.gen(function* () {
      const resolver = makeModelResolver(new Map(), yield* Effect.scope);

      expect(yield* Effect.flip(resolver.resolve("missing/model"))).toMatchObject({
        _tag: "TurnError",
        message: "Unregistered Provider id: missing",
        cause: "missing/model",
      });
    }),
  );

  it.effect("translates Provider provision failures", () =>
    Effect.gen(function* () {
      const failure = new Error("provision failed");
      const provider = makeProvider("test", [] as const, undefined, () => {
        throw failure;
      });
      const resolver = makeModelResolver(new Map([[provider.id, provider]]), yield* Effect.scope);

      expect(yield* Effect.flip(resolver.resolve("test/model"))).toMatchObject({
        _tag: "TurnError",
        message: "provision failed",
        cause: failure,
      });
    }),
  );

  it.effect("caches Models by full Qualified Model id", () =>
    Effect.gen(function* () {
      const provisioned: Array<string> = [];
      const provider = makeProvider("test", [] as const, undefined, (modelId) => {
        provisioned.push(modelId);
        return Layer.succeed(LanguageModel.LanguageModel, model);
      });
      const resolver = makeModelResolver(new Map([[provider.id, provider]]), yield* Effect.scope);

      const first = yield* resolver.resolve("test/one");
      expect(yield* resolver.resolve("test/one")).toBe(first);
      yield* resolver.resolve("test/two");
      expect(provisioned).toEqual(["one", "two"]);
    }),
  );

  it.effect("holds provisioned Models for its Scope lifetime", () =>
    Effect.gen(function* () {
      let releases = 0;
      const provider = makeProvider("test", [] as const, undefined, () =>
        Layer.effect(
          LanguageModel.LanguageModel,
          Effect.acquireRelease(Effect.succeed(model), () =>
            Effect.sync(() => {
              releases += 1;
            }),
          ),
        ),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const resolver = makeModelResolver(
            new Map([[provider.id, provider]]),
            yield* Effect.scope,
          );
          yield* resolver.resolve("test/model");
          expect(releases).toBe(0);
        }),
      );

      expect(releases).toBe(1);
    }),
  );
});
