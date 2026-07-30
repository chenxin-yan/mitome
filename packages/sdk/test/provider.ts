import { Effect, Layer, Ref, Stream } from "effect";
import { LanguageModel, Prompt, Response, Tool, Toolkit } from "effect/unstable/ai";
import { makeProvider } from "@mitome/core";
import type { InputSchema, StandardSchema } from "../src/index.js";

interface TestModelOptions {
  readonly prompt: Prompt.Prompt;
  readonly toolkit?: Toolkit.WithHandler<Record<string, Tool.Any>>;
}

export const stringSchema: StandardSchema<unknown, string> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) =>
      typeof value === "string"
        ? { value, issues: undefined }
        : { issues: [{ message: "expected string" }] },
  },
};

export const jsonStringSchema: InputSchema<string> = {
  "~standard": {
    ...stringSchema["~standard"],
    jsonSchema: {
      input: () => ({ type: "string" }),
      output: () => ({ type: "string" }),
    },
  },
};

// Deliberately raw Service fake (bypasses LanguageModel.make's tool-call pipeline)
// so tests can reach the Service-level toolkit directly. Sibling copy:
// packages/core/test/support/provider.ts.
export const testLanguageModel = (
  streamText: (options: TestModelOptions) => unknown,
): LanguageModel.Service => ({ streamText }) as unknown as LanguageModel.Service;

export const makeTestProvider = (
  streamText: (options: TestModelOptions) => unknown,
  name = "test",
) =>
  makeProvider(name, [] as const, undefined, () =>
    Layer.succeed(LanguageModel.LanguageModel, testLanguageModel(streamText)),
  );

export const makeToolModel = (name = "echo", doneAt = 2) => {
  let calls = 0;
  let secondPrompt: Prompt.Prompt | undefined;
  const provider = makeTestProvider((options) => {
    calls += 1;
    if (calls === doneAt) {
      secondPrompt = options.prompt;
      return Stream.succeed(Response.makePart("text-delta", { id: "done", delta: "done" }));
    }
    const call = Response.makePart("tool-call", {
      id: `call-${calls}`,
      name,
      params: "hello",
      providerExecuted: false,
    });
    return Stream.concat(
      Stream.succeed(call),
      Stream.unwrap(
        options.toolkit!.handle(name, "hello").pipe(
          Effect.map((results) =>
            Stream.map(results, (result) =>
              Response.makePart("tool-result", {
                id: call.id,
                name: call.name,
                providerExecuted: false,
                ...result,
              }),
            ),
          ),
        ),
      ),
    );
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

    return {
      provider: makeProvider("test", [] as const, undefined, () => layer),
      calls: Ref.get(calls),
      released: Ref.get(released),
    };
  });
