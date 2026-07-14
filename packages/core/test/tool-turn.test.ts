import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Stream } from "effect";
import { AiError, Prompt, Response, Tool, Toolkit } from "effect/unstable/ai";
import { Schema } from "effect";
import { createSession, definePlugin, TurnStepLimitError, type Definition } from "../src/index.js";
import { makeTestModel } from "./model.js";

const makeToolModel = () => {
  let calls = 0;
  let secondPrompt: Prompt.Prompt | undefined;
  return {
    model: makeTestModel((options) => {
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
    }),
    calls: () => calls,
    prompt: () => secondPrompt,
  };
};

describe("createSession Tool Turn", () => {
  it.effect("runs a Tool Step, records its result, then completes the next Step", () =>
    Effect.gen(function* () {
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
          definePlugin({
            name: "echo",
            toolkit: Toolkit.make(echo),
            handlers: { echo: ({ text }) => Effect.succeed(text) },
          }),
        ],
      };

      const session = yield* createSession(definition);
      const events = yield* Stream.runCollect(session.prompt("Hi"));

      expect([...events]).toEqual([
        { type: "tool-call", id: "call-1", name: "echo" },
        { type: "tool-result", id: "call-1", name: "echo", result: "hello", isFailure: false },
        { type: "model-output", text: "done" },
        { type: "response-complete" },
      ]);
      expect(fixture.calls()).toBe(2);
      expect(fixture.prompt()?.content.map((message) => message.role)).toEqual([
        "system",
        "user",
        "assistant",
        "tool",
      ]);
    }),
  );

  it.effect("does not start another Step for a provider-executed Tool call", () =>
    Effect.gen(function* () {
      let calls = 0;
      const model = makeTestModel(() => {
        calls += 1;
        return Stream.succeed(
          Response.makePart("tool-call", {
            id: "provider-call",
            name: "web-search",
            params: {},
            providerExecuted: true,
          }),
        );
      });

      const session = yield* createSession({ instructions: "Search.", model, plugins: [] });
      const events = yield* Stream.runCollect(session.prompt("Find it"));

      expect([...events]).toEqual([
        { type: "tool-call", id: "provider-call", name: "web-search" },
        { type: "response-complete" },
      ]);
      expect(calls).toBe(1);
    }),
  );

  it.effect("fails after the fixed 16 model Step limit", () =>
    Effect.gen(function* () {
      let calls = 0;
      const echo = Tool.make("echo", { success: Schema.String });
      const model = makeTestModel(() => {
        calls += 1;
        return Stream.succeed(
          calls === 17
            ? Response.makePart("text-delta", { id: "done", delta: "done" })
            : Response.makePart("tool-call", {
                id: `call-${calls}`,
                name: "echo",
                params: {},
                providerExecuted: false,
              }),
        );
      });

      const session = yield* createSession({
        instructions: "Keep calling.",
        model,
        plugins: [
          {
            name: "echo",
            toolkit: Toolkit.make(echo),
            handlers: { echo: () => Effect.succeed("echo") },
          },
        ],
      });
      const exit = yield* Effect.exit(Stream.runDrain(session.prompt("Start")));
      const history = session.history();
      const reuseEvents = yield* Stream.runCollect(session.prompt("Again"));

      expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toBeInstanceOf(
        TurnStepLimitError,
      );
      expect(history).toHaveLength(1);
      expect(reuseEvents.at(-1)).toEqual({ type: "response-complete" });
      expect(calls).toBe(17);
    }),
  );

  it.effect("allows exactly sixteen Steps", () =>
    Effect.gen(function* () {
      let calls = 0;
      const echo = Tool.make("echo", { success: Schema.String });
      const model = makeTestModel(() => {
        calls += 1;
        if (calls === 16) {
          return Stream.succeed(Response.makePart("text-delta", { id: "done", delta: "done" }));
        }
        return Stream.succeed(
          Response.makePart("tool-call", {
            id: `call-${calls}`,
            name: "echo",
            params: {},
            providerExecuted: false,
          }),
        );
      });

      const session = yield* createSession({
        instructions: "Keep calling.",
        model,
        plugins: [
          {
            name: "echo",
            toolkit: Toolkit.make(echo),
            handlers: { echo: () => Effect.succeed("echo") },
          },
        ],
      });
      const events = yield* Stream.runCollect(session.prompt("Start"));

      expect(calls).toBe(16);
      expect(events.at(-1)).toEqual({ type: "response-complete" });
    }),
  );

  it.effect("passes through a dynamic Tool failure without running post-Tool Hooks", () =>
    Effect.gen(function* () {
      const fixture = makeToolModel();
      let postCalls = 0;
      const echo = Tool.dynamic("echo", {
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
        failureMode: "return",
      });
      const definition: Definition = {
        instructions: "Be concise.",
        model: fixture.model,
        plugins: [
          {
            name: "observe",
            hooks: {
              postTool: ({ result }) =>
                Effect.sync(() => {
                  postCalls += 1;
                  return result;
                }),
            },
          },
          {
            name: "echo",
            toolkit: Toolkit.make(echo),
            handlers: {
              echo: () =>
                Effect.fail(
                  AiError.make({
                    module: "test",
                    method: "echo",
                    reason: new AiError.UnknownError({ description: "expected" }),
                  }),
                ),
            },
          },
        ],
      };

      const session = yield* createSession(definition);
      const events = yield* Stream.runCollect(session.prompt("Hi"));

      expect(events.find((event) => event.type === "tool-result")).toMatchObject({
        type: "tool-result",
        isFailure: true,
      });
      expect(postCalls).toBe(0);
      expect(events.at(-1)).toEqual({ type: "response-complete" });
    }),
  );

  it.effect("returns a Core-native Tool's typed failure and continues the Turn", () =>
    Effect.gen(function* () {
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

      const session = yield* createSession(definition);
      const events = yield* Stream.runCollect(session.prompt("Hi"));

      expect([...events]).toContainEqual({
        type: "tool-result",
        id: "call-1",
        name: "echo",
        result: { code: "expected" },
        isFailure: true,
      });
      expect(events.at(-1)).toEqual({ type: "response-complete" });
      expect(fixture.calls()).toBe(2);
    }),
  );
});
