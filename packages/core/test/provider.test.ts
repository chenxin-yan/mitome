import { describe, expect, it } from "@effect/vitest";
import { Layer, Stream } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { makeProvider } from "../src/index.js";

const stubLayer = Layer.succeed(LanguageModel.LanguageModel, {
  streamText: () => Stream.empty,
} as unknown as LanguageModel.Service);

describe("makeProvider", () => {
  it("rejects Provider ids that cannot qualify a Model identifier", () => {
    const invalidIds: ReadonlyArray<string> = ["", "invalid/id"];
    for (const id of invalidIds) {
      expect(() => makeProvider(id, [], undefined, () => stubLayer)).toThrowError(
        "Provider id must be non-empty and contain no '/'",
      );
    }
  });

  it("exposes only its id and Model catalog hints", () => {
    const provider = makeProvider(
      "example",
      ["known"] as const,
      "EXAMPLE_API_KEY",
      () => stubLayer,
    );

    expect(provider).toEqual({ id: "example", modelIds: ["known"] });
    expect(JSON.stringify(provider)).toBe('{"id":"example","modelIds":["known"]}');
  });
});
