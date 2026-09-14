import { Effect, Layer, Ref, Schema, Stream } from "effect";
import { AiError, LanguageModel, Prompt, Response } from "effect/unstable/ai";
import { makeProvider } from "@mitome/core";
import type { InputSchema, StandardSchema } from "../src/index.js";

type TestStreamText = (
  options: LanguageModel.ProviderOptions,
) => Stream.Stream<Response.StreamPartEncoded, AiError.AiError>;

export const stringSchema: StandardSchema<unknown, string> = Schema.toStandardSchemaV1(
  Schema.String,
);
export const jsonStringSchema: InputSchema<string> = Schema.String;

// Built through the real LanguageModel.make so every Tool Call runs Core's preparation
// (input validation, Hooks, Approval) exactly as it does under a real Provider.
const testLanguageModel = (streamText: TestStreamText) =>
  LanguageModel.make({
    streamText,
    generateText: () => Effect.die("generateText is not used by these tests"),
  });

export const makeTestProvider = (streamText: TestStreamText, name = "test") =>
  makeProvider(name, [] as const, undefined, () =>
    Layer.effect(LanguageModel.LanguageModel, testLanguageModel(streamText)),
  );

/** Emits one Tool Call per Step until `doneAt`, then a final text Step. */
export const makeToolModel = (
  name = "echo",
  doneAt = 2,
  params: Response.ToolCallPartEncoded["params"] = "hello",
) => {
  let calls = 0;
  let secondPrompt: Prompt.Prompt | undefined;
  const provider = makeTestProvider((options) => {
    calls += 1;
    if (calls === doneAt) {
      secondPrompt = options.prompt;
      return Stream.succeed(Response.makePart("text-delta", { id: "done", delta: "done" }));
    }
    return Stream.succeed({ type: "tool-call", id: `call-${calls}`, name, params });
  });
  return { provider, calls: () => calls, prompt: () => secondPrompt };
};

export const makeDeterministicProvider = (output: string) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const released = yield* Ref.make(false);
    const layer = Layer.effect(
      LanguageModel.LanguageModel,
      Effect.acquireRelease(
        testLanguageModel(() =>
          Stream.fromEffect(Ref.update(calls, (count) => count + 1)).pipe(
            Stream.map(() =>
              Response.makePart("text-delta", { id: "deterministic", delta: output }),
            ),
          ),
        ),
        () => Ref.set(released, true),
      ),
    );

    return {
      provider: makeProvider("test", [] as const, undefined, () => layer),
      calls: Ref.get(calls),
      released: Ref.get(released),
    };
  });
