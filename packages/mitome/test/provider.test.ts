import { describe, expect, it } from "@effect/vitest";
import { Cause, Context, Effect, Exit, Layer, Predicate, Schema, Stream } from "effect";
import { LanguageModel } from "effect/ai";
import { CredentialDescriptorSchema, Provider, withModelRequestAccounting } from "../src/index.js";
import { getProviderMetadata, isProvider, parseQualifiedModelId } from "../src/session/internal.js";
import { testLanguageModel } from "./support/provider.js";

const stubLayer = Layer.succeed(
  LanguageModel.LanguageModel,
  testLanguageModel(() => Stream.empty),
);

describe("Provider.make", () => {
  it("rejects Provider ids that cannot form a Qualified Model id", () => {
    const invalidIds: ReadonlyArray<string> = ["", "invalid/id"];
    for (const id of invalidIds) {
      expect(() => Provider.make(id, { modelIds: [], provision: () => stubLayer })).toThrowError(
        "Provider id must be non-empty and contain no '/'",
      );
    }
  });

  it("rejects invalid environment Credential names", () => {
    expect(() =>
      Provider.make("example", {
        modelIds: [],
        credential: "INVALID-NAME",
        provision: () => stubLayer,
      }),
    ).toThrowError("Provider credential must be a valid environment variable name");
    const capability = { module: "./auth.js" };
    expect(() =>
      Provider.make("example", {
        modelIds: [],
        credential: { env: "INVALID-NAME", capability },
        provision: () => stubLayer,
      }),
    ).toThrowError("Provider credential must be a valid environment variable name");
    const both = Provider.make("example", {
      modelIds: [],
      credential: { env: "EXAMPLE_KEY", capability },
      provision: () => stubLayer,
    });
    expect(Provider.credentialDescriptor(both)).toEqual({ env: "EXAMPLE_KEY", capability });
  });

  it("decodes an API-key variable with a sign-in without dropping the variable", () => {
    const decode = Schema.decodeUnknownSync(CredentialDescriptorSchema);
    const both = { env: "EXAMPLE_KEY", capability: { module: "./auth.js", profile: "work" } };
    expect(decode(both)).toEqual(both);
    expect(decode({ capability: { module: "./a.js" } })).toEqual({
      capability: { module: "./a.js" },
    });
    // An invalid variable is not dropped to leave a sign-in only.
    expect(() => decode({ env: "BAD-NAME", capability: { module: "./auth.js" } })).toThrow(
      Schema.SchemaError,
    );
  });

  it("takes its Credential and Model metadata as optional fields", () => {
    const bare = Provider.make("bare", { modelIds: [], provision: () => stubLayer });
    expect(Provider.credentialDescriptor(bare)).toBeUndefined();
    expect(getProviderMetadata(bare)?.models).toEqual({});
    const keyed = Provider.make("keyed", {
      modelIds: [],
      credential: "KEYED_API_KEY",
      provision: () => stubLayer,
    });
    expect(Provider.credentialDescriptor(keyed)).toBe("KEYED_API_KEY");
  });

  it("exposes only its id and Model catalog hints", () => {
    const provider = Provider.make("example", {
      modelIds: ["known"] as const,
      credential: "EXAMPLE_API_KEY",
      provision: () => stubLayer,
      models: { known: { contextWindow: 128_000 } },
    });

    expect(provider).toEqual({ id: "example", modelIds: ["known"] });
    expect(JSON.stringify(provider)).toBe('{"id":"example","modelIds":["known"]}');
  });

  it("keeps a serviceful Provider's requirement after a runtime brand check", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        class Upstream extends Context.Service<Upstream, { readonly url: string }>()(
          "test/Upstream",
        ) {}
        // Provisioning actually needs Upstream, so it is not a closed Provider.
        const serviceful = Provider.make("serviceful", {
          modelIds: [] as const,
          credential: "SERVICEFUL_KEY",
          provision: () =>
            withModelRequestAccounting(
              "serviceful",
              Layer.effect(
                LanguageModel.LanguageModel,
                Effect.andThen(Upstream, Effect.succeed(testLanguageModel(() => Stream.empty))),
              ),
            ),
        });
        const loaded: unknown = serviceful;
        if (!Predicate.isObject(loaded) || !isProvider(loaded)) {
          throw new Error("not a Provider");
        }
        // Catalog and authentication data work for the guarded Provider.
        expect(Provider.credentialDescriptor(loaded)).toBe("SERVICEFUL_KEY");
        // Running it needs the service it declared: its type keeps an unknown requirement, and
        // supplying the service is what makes it run.
        const built = yield* Effect.exit(
          Effect.scoped(Layer.build(Provider.model(serviceful, "m"))).pipe(
            Effect.provideService(Upstream, { url: "http://upstream" }),
          ),
        );
        expect(Exit.isSuccess(built)).toBe(true);
        // A counterexample outside the type system: without the service it defects.
        const unprovided: Effect.Effect<unknown, unknown, never> = Effect.scoped(
          // SAFETY: deliberate counterexample erasing the requirement to show what it guards.
          Layer.build(Provider.model(loaded, "m")) as Effect.Effect<unknown, unknown, never>,
        );
        const missing = yield* Effect.exit(unprovided);
        expect(Exit.isFailure(missing) && Cause.hasDies(missing.cause)).toBe(true);
      }),
    ));

  // Selection and metadata assertions kept from the deleted legacy Model resolver, at the surviving
  // Provider boundaries.
  it("splits Qualified Model ids at the first slash and rejects malformed ones", () => {
    expect(parseQualifiedModelId("test/known")).toEqual({ providerId: "test", modelId: "known" });
    expect(parseQualifiedModelId("test/org/nested")).toEqual({
      providerId: "test",
      modelId: "org/nested",
    });
    for (const malformed of ["malformed", "/model", "test/", 42]) {
      expect(parseQualifiedModelId(malformed)).toBeUndefined();
    }
  });

  it("keeps Provider-declared context windows, with none guessed for unknown ids", () => {
    const provider = Provider.make("test", {
      modelIds: ["known"] as const,
      provision: () => stubLayer,
      models: { known: { contextWindow: 128_000 }, "org/nested": { contextWindow: 32_000 } },
    });
    const models = getProviderMetadata(provider)?.models ?? {};
    expect(models["known"]?.contextWindow).toBe(128_000);
    expect(models["org/nested"]?.contextWindow).toBe(32_000);
    expect(models["unknown"]).toBeUndefined();
  });

  it("keeps a provisioning failure and defect native when its binding is built", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        class ProvisionFailed extends Error {}
        const failure = new ProvisionFailed("provision failed");
        const failing = Provider.make("failing", {
          modelIds: [] as const,
          provision: () => Layer.effect(LanguageModel.LanguageModel, Effect.fail(failure)),
        });
        const failed = yield* Effect.exit(Effect.scoped(Layer.build(Provider.model(failing, "m"))));
        expect(Exit.isFailure(failed) && Cause.squash(failed.cause)).toBe(failure);
        const throwing = Provider.make("throwing", {
          modelIds: [] as const,
          provision: () => {
            throw failure;
          },
        });
        const thrown = yield* Effect.exit(
          Effect.scoped(Layer.build(Provider.model(throwing, "m"))),
        );
        expect(Exit.isFailure(thrown) && Cause.hasDies(thrown.cause)).toBe(true);
      }),
    ));
});
