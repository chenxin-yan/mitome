import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { makeProvider } from "../../src/index.js";
import { makeModelResolver } from "../../src/session/model-resolver.js";
import { testLanguageModel } from "../support/provider.js";

const stubLayer = Layer.succeed(
  LanguageModel.LanguageModel,
  testLanguageModel(() => Stream.empty),
);

describe("ModelResolver", () => {
  it.effect("exposes the selected ids and the Provider-declared context window", () =>
    Effect.gen(function* () {
      const provider = makeProvider("test", ["known"] as const, undefined, () => stubLayer, {
        known: { contextWindow: 128_000 },
        "org/nested": { contextWindow: 32_000 },
      });
      const resolve = makeModelResolver(new Map([[provider.id, provider]]), yield* Effect.scope);

      expect(yield* resolve("test/known")).toMatchObject({
        id: "test/known",
        providerId: "test",
        modelId: "known",
        contextWindow: 128_000,
      });
      // Native ids keep later `/` characters and still find their metadata.
      expect(yield* resolve("test/org/nested")).toMatchObject({
        modelId: "org/nested",
        contextWindow: 32_000,
      });
      // Unknown ids are provisioned as-is with no guessed window.
      const unknown = yield* resolve("test/unknown");
      expect(unknown).toMatchObject({ id: "test/unknown", modelId: "unknown" });
      expect(unknown.contextWindow).toBeUndefined();
      // Cached resolution keeps the absent window absent.
      expect(yield* resolve("test/unknown")).toBe(unknown);
    }),
  );

  it.effect("translates malformed Qualified Model ids", () =>
    Effect.gen(function* () {
      const resolve = makeModelResolver(new Map(), yield* Effect.scope);

      expect(yield* Effect.flip(resolve("malformed"))).toMatchObject({
        _tag: "TurnError",
        message: "Malformed Qualified Model id: malformed",
        cause: "malformed",
      });
    }),
  );

  it.effect("translates Provider provision failures", () =>
    Effect.gen(function* () {
      const failure = new Error("provision failed");
      const provider = makeProvider("test", [] as const, undefined, () => {
        throw failure;
      });
      const resolve = makeModelResolver(new Map([[provider.id, provider]]), yield* Effect.scope);

      expect(yield* Effect.flip(resolve("test/model"))).toMatchObject({
        _tag: "TurnError",
        message: "provision failed",
        cause: failure,
      });
    }),
  );
});
