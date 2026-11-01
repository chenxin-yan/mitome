import { Effect, Schema, Stream } from "effect";
import { LanguageModel, Prompt, Response, Tool, Toolkit } from "effect/ai";

interface TestModelOptions {
  readonly prompt: Prompt.Prompt;
  readonly toolkit?: Toolkit.WithHandler<Record<string, Tool.Any>>;
}

// Deliberately raw Service fake rather than the LanguageModel.make pipeline.
type TestModelStream = Stream.Stream<Response.AnyPart, typeof Schema.Unknown.Type, any>;

export const testLanguageModel = (
  streamText: (options: TestModelOptions) => TestModelStream,
): LanguageModel.LanguageModel => {
  const unsupported = () => Effect.die("Only streamText is supported by this test model");
  return {
    [LanguageModel.TypeId]: LanguageModel.TypeId,
    generateText: unsupported,
    generateObject: unsupported,
    // SAFETY: The raw fake erases TestModelStream's error/context channels; tests only
    // consume the parts streamText emits and never observe the erased typing.
    streamText: streamText as LanguageModel.LanguageModel["streamText"],
  };
};
