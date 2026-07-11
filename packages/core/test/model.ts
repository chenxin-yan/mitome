import { Effect, Layer, Ref, Stream } from "effect";
import { LanguageModel, Response } from "effect/unstable/ai";
import { makeModel } from "../src/index.js";

export const makeDeterministicModel = (output: string) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const layer = Layer.succeed(LanguageModel.LanguageModel, {
      streamText: () =>
        Stream.fromEffect(Ref.update(calls, (count) => count + 1)).pipe(
          Stream.map(() => Response.makePart("text-delta", { id: "deterministic", delta: output })),
        ),
    } as LanguageModel.Service);

    return { model: makeModel(layer), calls: Ref.get(calls) };
  });
