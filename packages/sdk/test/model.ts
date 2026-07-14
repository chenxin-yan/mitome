import { Layer } from "effect";
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/unstable/ai";
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
