import { Effect, Layer, Ref, Stream } from "effect";
import { LanguageModel, Prompt, Response, Tool, Toolkit } from "effect/unstable/ai";
import { makeProvider } from "../../src/index.js";

interface TestModelOptions {
  readonly prompt: Prompt.Prompt;
  readonly toolkit?: Toolkit.WithHandler<Record<string, Tool.Any>>;
}

export const makeTestProvider = (streamText: (options: TestModelOptions) => unknown) =>
  makeProvider("test", [] as const, undefined, () =>
    Layer.succeed(LanguageModel.LanguageModel, {
      streamText,
    } as unknown as LanguageModel.Service),
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
