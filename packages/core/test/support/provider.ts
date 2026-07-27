import { Effect, Layer, Ref, Stream } from "effect";
import { LanguageModel, Prompt, Response, Tool, Toolkit } from "effect/unstable/ai";
import { makeProvider } from "../../src/index.js";

interface TestModelOptions {
  readonly prompt: Prompt.Prompt;
  readonly toolkit?: Toolkit.WithHandler<Record<string, Tool.Any>>;
}

export const testLanguageModel = (
  streamText: (options: TestModelOptions) => unknown,
): LanguageModel.Service => ({ streamText }) as unknown as LanguageModel.Service;

export const makeTestProvider = (streamText: (options: TestModelOptions) => unknown) =>
  makeProvider("test", [] as const, undefined, () =>
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
  makeProvider("test", [] as const, undefined, () =>
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
