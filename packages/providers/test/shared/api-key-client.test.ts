import { describe, expect, it } from "@effect/vitest";
import { Config, Effect, Layer, Redacted } from "effect";
import * as Context from "effect/Context";
import { makeApiKeyClient } from "../../src/shared/api-key-client.js";

class TestClient extends Context.Service<TestClient, {}>()("test/TestClient") {}

const key = "MITOME_LATE_API_KEY_TEST";

describe("API-key client", () => {
  it.live("reads an environment key set after Provider construction", () =>
    Effect.promise(async () => {
      const previous = process.env[key];
      delete process.env[key];
      try {
        // Populate Effect's process-wide default provider before the key exists.
        await Effect.runPromise(Effect.result(Config.string(key)));
        let observed: string | undefined;
        const layer = makeApiKeyClient(key, "https://test.invalid", ({ apiKey }) => {
          observed = apiKey === undefined ? undefined : Redacted.value(apiKey);
          return Layer.succeed(TestClient, {});
        });

        process.env[key] = "late-key";
        await Effect.runPromise(Effect.scoped(Layer.build(layer)));
        expect(observed).toBe("late-key");
      } finally {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }
    }),
  );
});
