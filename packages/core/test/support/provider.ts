import { Effect, Layer, Ref, Schema, Stream } from "effect";
import { LanguageModel, Prompt, Response, Tool, Toolkit } from "effect/unstable/ai";
import * as Provider from "../../src/provider.js";

interface TestModelOptions {
  readonly prompt: Prompt.Prompt;
  readonly toolkit?: Toolkit.WithHandler<Record<string, Tool.Any>>;
}

// Deliberately raw Service fake; use makeStreamingTestProvider below for the real
// LanguageModel.make pipeline. Sibling copy: packages/sdk/test/provider.ts.
type TestModelStream = Stream.Stream<Response.AnyPart, typeof Schema.Unknown.Type, any>;

export const testLanguageModel = (
  streamText: (options: TestModelOptions) => TestModelStream,
): LanguageModel.Service => {
  const unsupported = () => Effect.die("Only streamText is supported by this test model");
  return {
    generateText: unsupported,
    generateObject: unsupported,
    // SAFETY: The raw fake erases TestModelStream's error/context channels; tests only
    // consume the parts streamText emits and never observe the erased typing.
    streamText: streamText as LanguageModel.Service["streamText"],
  };
};

export const makeTestProvider = (streamText: (options: TestModelOptions) => TestModelStream) =>
  Provider.makeProvider("test", [] as const, undefined, () =>
    Layer.succeed(LanguageModel.LanguageModel, testLanguageModel(streamText)),
  );

/**
 * Builds the Service through the real LanguageModel.make, so requests run
 * upstream's full tool-call pipeline (needsApproval, concurrency, handlers)
 * instead of the raw fake above.
 */
export const makeStreamingTestProvider = (
  streamText: (
    options: LanguageModel.ProviderOptions,
  ) => Stream.Stream<Response.StreamPartEncoded, never>,
) =>
  Provider.makeProvider("test", [] as const, undefined, () =>
    Layer.effect(
      LanguageModel.LanguageModel,
      LanguageModel.make({
        streamText,
        generateText: () => Effect.die("generateText is not used by these tests"),
      }),
    ),
  );

export const makeDeterministicProvider = (output: string) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const provider = makeTestProvider(() =>
      Stream.fromEffect(Ref.update(calls, (count) => count + 1)).pipe(
        Stream.map(() => Response.makePart("text-delta", { id: "deterministic", delta: output })),
      ),
    );

    return { provider, calls: Ref.get(calls) };
  });
