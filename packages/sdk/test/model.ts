import { Effect, Layer, Ref, Stream } from "effect";
import { LanguageModel, Prompt, Response, Tool, Toolkit } from "effect/unstable/ai";
import { makeModel } from "@mitome/core";

interface TestModelOptions {
  readonly prompt: Prompt.Prompt;
  readonly toolkit?: Toolkit.WithHandler<Record<string, Tool.Any>>;
}

export const testLanguageModel = (
  streamText: (options: TestModelOptions) => unknown,
): LanguageModel.Service => ({ streamText }) as unknown as LanguageModel.Service;

export const makeTestModel = (streamText: (options: TestModelOptions) => unknown) =>
  makeModel(Layer.succeed(LanguageModel.LanguageModel, testLanguageModel(streamText)));

export const makeDeterministicModel = (output: string) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const released = yield* Ref.make(false);
    const layer = Layer.effect(
      LanguageModel.LanguageModel,
      Effect.acquireRelease(
        Effect.succeed(
          testLanguageModel(() =>
            Stream.fromEffect(Ref.update(calls, (count) => count + 1)).pipe(
              Stream.map(() =>
                Response.makePart("text-delta", { id: "deterministic", delta: output }),
              ),
            ),
          ),
        ),
        () => Ref.set(released, true),
      ),
    );

    return { model: makeModel(layer), calls: Ref.get(calls), released: Ref.get(released) };
  });
