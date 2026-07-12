import { describe, expect, test } from "bun:test";
import { Effect, Layer, Stream } from "effect";
import { LanguageModel, Response, Tool, Toolkit } from "effect/unstable/ai";
import { Schema } from "effect";
import { createSession, makeModel, type Definition } from "../src/index.js";

const makeToolModel = () => {
  let calls = 0;
  let secondPrompt: unknown;
  return {
    model: makeModel(
      Layer.succeed(LanguageModel.LanguageModel, {
        streamText: (options: {
          readonly prompt: unknown;
          readonly toolkit?: Toolkit.WithHandler<any>;
        }) => {
          calls += 1;
          if (calls === 2) {
            secondPrompt = options.prompt;
            return Stream.succeed(Response.makePart("text-delta", { id: "second", delta: "done" }));
          }
          const call = Response.makePart("tool-call", {
            id: "call-1",
            name: "echo",
            params: { text: "hello" },
            providerExecuted: false,
          });
          return Stream.concat(
            Stream.succeed(call),
            Stream.unwrap(
              options.toolkit!.handle("echo", { text: "hello" }).pipe(
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
        },
      } as LanguageModel.Service),
    ),
    calls: () => calls,
    prompt: () => secondPrompt,
  };
};

describe("createSession Tool Turn", () => {
  test("runs a Tool Step, records its result, then completes the next Step", async () => {
    const fixture = makeToolModel();
    const echo = Tool.make("echo", {
      parameters: Schema.Struct({ text: Schema.String }),
      success: Schema.String,
      failure: Schema.Struct({ code: Schema.String }),
      failureMode: "return",
    });
    const definition: Definition = {
      instructions: "Be concise.",
      model: fixture.model,
      plugins: [
        {
          name: "echo",
          toolkit: Toolkit.make(echo),
          handlers: { echo: ({ text }) => Effect.succeed(text) },
        },
      ],
    };

    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* createSession(definition);
          return yield* Stream.runCollect(session.prompt("Hi"));
        }),
      ),
    );

    expect([...events]).toEqual([
      { type: "tool-call", id: "call-1", name: "echo" },
      { type: "tool-result", id: "call-1", name: "echo", result: "hello", isFailure: false },
      { type: "model-output", text: "done" },
      { type: "response-complete" },
    ]);
    expect(fixture.calls()).toBe(2);
    expect(
      (
        fixture.prompt() as { readonly content: ReadonlyArray<{ readonly role: string }> }
      ).content.map((message) => message.role),
    ).toEqual(["system", "user", "assistant", "tool"]);
  });

  test("returns a Core-native Tool's typed failure and continues the Turn", async () => {
    const fixture = makeToolModel();
    const echo = Tool.make("echo", {
      parameters: Schema.Struct({ text: Schema.String }),
      success: Schema.String,
      failure: Schema.Struct({ code: Schema.String }),
      failureMode: "return",
    });
    const definition: Definition = {
      instructions: "Be concise.",
      model: fixture.model,
      plugins: [
        {
          name: "echo",
          toolkit: Toolkit.make(echo),
          handlers: { echo: () => Effect.fail({ code: "expected" }) },
        },
      ],
    };

    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* createSession(definition);
          return yield* Stream.runCollect(session.prompt("Hi"));
        }),
      ),
    );

    expect([...events]).toContainEqual({
      type: "tool-result",
      id: "call-1",
      name: "echo",
      result: { code: "expected" },
      isFailure: true,
    });
    expect(events.at(-1)).toEqual({ type: "response-complete" });
    expect(fixture.calls()).toBe(2);
  });
});
