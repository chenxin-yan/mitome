import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { makeProvider } from "../../src/index.js";
import { makeModelResolver } from "../../src/session/model-resolver.js";

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
});
