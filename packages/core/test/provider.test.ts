import { describe, expect, it } from "@effect/vitest";
import { Layer, Stream } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { makeProvider } from "../src/index.js";

describe("makeProvider", () => {
  it("exposes only its id and Model catalog hints", () => {
    const provider = makeProvider("example", ["known"] as const, "EXAMPLE_API_KEY", () =>
      Layer.succeed(LanguageModel.LanguageModel, {
        streamText: () => Stream.empty,
      } as unknown as LanguageModel.Service),
    );

    expect(provider).toEqual({ id: "example", modelIds: ["known"] });
    expect(JSON.stringify(provider)).toBe('{"id":"example","modelIds":["known"]}');
  });
});
