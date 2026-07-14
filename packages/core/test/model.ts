import { Effect, Layer, Ref, Stream } from "effect";
import { LanguageModel, Prompt, Response, Tool, Toolkit } from "effect/unstable/ai";
import { makeModel } from "../src/index.js";

interface TestModelOptions {
  readonly prompt: Prompt.Prompt;
  readonly toolkit?: Toolkit.WithHandler<Record<string, Tool.Any>>;
}

export const makeTestModel = (streamText: (options: TestModelOptions) => unknown) =>
  makeModel(
    Layer.succeed(LanguageModel.LanguageModel, {
      streamText,
    } as unknown as LanguageModel.Service),
  );

export const makeDeterministicModel = (output: string) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const model = makeTestModel(() =>
      Stream.fromEffect(Ref.update(calls, (count) => count + 1)).pipe(
        Stream.map(() => Response.makePart("text-delta", { id: "deterministic", delta: output })),
      ),
    );

    return { model, calls: Ref.get(calls) };
  });
