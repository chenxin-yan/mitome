import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Predicate, Schema, Stream } from "effect";
import { AiError, LanguageModel, Prompt, Response, Tool, Toolkit } from "effect/unstable/ai";
import {
  type AgentDefinition,
  createSession,
  defineExtension,
  makeProvider,
} from "../../src/index.js";
import { makeTestProvider } from "../support/provider.js";

const makeToolModel = () => {
  let calls = 0;
  let secondPrompt: Prompt.Prompt | undefined;
  return {
    provider: makeTestProvider((options) => {
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
      const definition: AgentDefinition = {
        providers: [fixture.provider],
        model: "test/default",
        extensions: [
          defineExtension({
            name: "echo",
            toolkit: Toolkit.make(echo),
            handlers: { echo: ({ text }) => Effect.succeed(text) },
          }),
        ],
      };

      const session = yield* createSession(definition);
      const events = yield* Stream.runCollect(session.prompt("Hi"));

      expect([...events]).toEqual([
        { type: "tool-call", id: "call-1", name: "echo", params: { text: "hello" } },
        { type: "tool-result", id: "call-1", name: "echo", result: "hello", isFailure: false },
        { type: "model-output", text: "done" },
        { type: "response-complete" },
      ]);
      expect(fixture.calls()).toBe(2);
      expect(fixture.prompt()?.content.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "tool",
      ]);
    }),
  );

  it.effect("does not start another Step for a provider-executed Tool call", () =>
    Effect.gen(function* () {
      let calls = 0;
      const model = makeTestProvider(() => {
        calls += 1;
        return Stream.fromIterable([
          Response.makePart("tool-call", {
            id: "provider-call",
            name: "web-search",
            params: {},
            providerExecuted: true,
          }),
          Response.makePart("tool-result", {
            id: "provider-call",
            name: "web-search",
            result: "found",
            encodedResult: "found",
            isFailure: false,
            preliminary: false,
            providerExecuted: true,
          }),
        ]);
      });

      const session = yield* createSession({
        providers: [model],
        model: "test/default",
        extensions: [],
      });
      const events = yield* Stream.runCollect(session.prompt("Find it"));

      expect([...events]).toEqual([
        { type: "tool-call", id: "provider-call", name: "web-search", params: {} },
        {
          type: "tool-result",
          id: "provider-call",
          name: "web-search",
          result: "found",
          isFailure: false,
        },
        { type: "response-complete" },
      ]);
      expect(calls).toBe(1);
    }),
  );

  it.effect("allows more than sixteen Steps", () =>
    Effect.gen(function* () {
      let calls = 0;
      const echo = Tool.make("echo", { success: Schema.String });
      const model = makeTestProvider(() => {
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
        providers: [model],
        model: "test/default",
        extensions: [
          {
            name: "echo",
            toolkit: Toolkit.make(echo),
            handlers: { echo: () => Effect.succeed("echo") },
          },
        ],
      });
      const events = yield* Stream.runCollect(session.prompt("Start"));

      expect(calls).toBe(17);
      expect(events.at(-1)).toEqual({ type: "response-complete" });
    }),
  );

  it.effect("returns input validation failures to the model without executing the Tool", () =>
    Effect.gen(function* () {
      const order: Array<string> = [];
      const validationFailure = new Error("invalid input");
      let modelCalls = 0;
      const provider = makeProvider("test", [] as const, undefined, () =>
        Layer.effect(
          LanguageModel.LanguageModel,
          LanguageModel.make({
            generateText: () => Effect.succeed([]),
            streamText: () => {
              modelCalls += 1;
              return Stream.succeed(
                modelCalls === 1
                  ? {
                      type: "tool-call" as const,
                      id: "call-1",
                      name: "echo",
                      params: { text: "hello" },
                    }
                  : { type: "text-delta" as const, id: "done", delta: "done" },
              );
            },
          }),
        ),
      );
      const echo = Tool.make("echo", {
        parameters: Schema.Struct({ text: Schema.String }),
        success: Schema.String,
      });
      const session = yield* createSession({
        providers: [provider],
        model: "test/default",
        extensions: [
          {
            name: "echo",
            toolkit: Toolkit.make(echo),
            handlers: {
              echo: () =>
                Effect.sync(() => {
                  order.push("handler");
                  return "handled";
                }),
            },
            toolInputValidators: {
              echo: () =>
                Effect.sync(() => order.push("validator")).pipe(
                  Effect.andThen(Effect.fail(validationFailure)),
                ),
            },
            hooks: {
              preTool: () => Effect.sync(() => void order.push("preTool")),
            },
          },
        ],
      });

      const events = yield* Stream.runCollect(session.prompt("Hi"));

      expect([...events]).toEqual([
        { type: "tool-call", id: "call-1", name: "echo", params: { text: "hello" } },
        {
          type: "tool-result",
          id: "call-1",
          name: "echo",
          result: {
            type: "execution-denied",
            reason: "Tool input validation failed: invalid input",
          },
          isFailure: true,
        },
        { type: "model-output", text: "done" },
        { type: "response-complete" },
      ]);
      expect(order).toEqual(["validator"]);
      expect(modelCalls).toBe(2);
    }),
  );

  it.effect("fails the Turn when an input validator defects", () =>
    Effect.gen(function* () {
      const order: Array<string> = [];
      const defect = new Error("validator defect");
      const provider = makeProvider("test", [] as const, undefined, () =>
        Layer.effect(
          LanguageModel.LanguageModel,
          LanguageModel.make({
            generateText: () => Effect.succeed([]),
            streamText: () =>
              Stream.succeed({
                type: "tool-call" as const,
                id: "call-1",
                name: "echo",
                params: { text: "hello" },
              }),
          }),
        ),
      );
      const echo = Tool.make("echo", {
        parameters: Schema.Struct({ text: Schema.String }),
        success: Schema.String,
      });
      const session = yield* createSession({
        providers: [provider],
        model: "test/default",
        extensions: [
          {
            name: "echo",
            toolkit: Toolkit.make(echo),
            handlers: {
              echo: () =>
                Effect.sync(() => {
                  order.push("handler");
                  return "handled";
                }),
            },
            toolInputValidators: { echo: () => Effect.die(defect) },
            hooks: {
              preTool: () => Effect.sync(() => void order.push("preTool")),
            },
          },
        ],
      });

      const error = yield* Effect.flip(Stream.runDrain(session.prompt("Hi")));

      expect(error).toMatchObject({
        _tag: "TurnError",
        message: "Tool input validator failed",
        cause: defect,
      });
      expect(order).toEqual([]);
    }),
  );

  it.effect("fails closed if a prepared Hook failure reaches Tool handling", () =>
    Effect.gen(function* () {
      const order: Array<string> = [];
      const failure = new Error("preTool failed");
      let modelCalls = 0;
      const provider = makeTestProvider((options) => {
        modelCalls += 1;
        if (modelCalls === 2) {
          return Stream.succeed(Response.makePart("text-delta", { id: "done", delta: "done" }));
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
            Effect.gen(function* () {
              const needsApproval = options.toolkit!.tools.echo!.needsApproval;
              if (!Predicate.isFunction(needsApproval)) {
                return yield* Effect.die("Wrapped Tool has no Approval predicate");
              }
              const decision = needsApproval(call.params, {
                toolCallId: call.id,
                messages: [],
              });
              const required = yield* Effect.isEffect(decision)
                ? decision
                : Effect.succeed(decision);
              if (!required) return yield* Effect.die("Prepared Hook failure did not fail closed");
              return yield* options.toolkit!.handle(call.name, call.params, call.id).pipe(
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
              );
            }),
          ),
        );
      });
      const echo = Tool.make("echo", {
        parameters: Schema.Struct({ text: Schema.String }),
        success: Schema.String,
      });
      const session = yield* createSession({
        providers: [provider],
        model: "test/default",
        extensions: [
          {
            name: "echo",
            toolkit: Toolkit.make(echo),
            handlers: {
              echo: () =>
                Effect.sync(() => {
                  order.push("handler");
                  return "handled";
                }),
            },
            hooks: {
              preTool: () =>
                Effect.sync(() => order.push("preTool")).pipe(Effect.andThen(Effect.fail(failure))),
            },
          },
        ],
      });

      const error = yield* Effect.flip(Stream.runDrain(session.prompt("Hi")));

      expect(error).toMatchObject({
        _tag: "TurnError",
        message: "Pre-Tool Hook failed: preTool failed",
        cause: {
          _tag: "AiError",
          module: "@mitome/core",
          method: "preTool",
        },
      });
      expect(order).toEqual(["preTool"]);
      expect(modelCalls).toBe(1);
    }),
  );

  it.effect("validates successful Tool results after post-Tool Hooks", () =>
    Effect.gen(function* () {
      const fixture = makeToolModel();
      const order: Array<string> = [];
      const echo = Tool.make("echo", {
        parameters: Schema.Struct({ text: Schema.String }),
        success: Schema.String,
      });
      const session = yield* createSession({
        providers: [fixture.provider],
        model: "test/default",
        extensions: [
          {
            name: "echo",
            toolkit: Toolkit.make(echo),
            handlers: {
              echo: () =>
                Effect.sync(() => {
                  order.push("handler");
                  return "handled";
                }),
            },
            toolResultValidators: {
              echo: () =>
                Effect.sync(() => {
                  order.push("validator");
                  return "validated";
                }),
            },
            hooks: {
              postTool: () =>
                Effect.sync(() => {
                  order.push("postTool");
                  return "post";
                }),
            },
          },
        ],
      });

      const events = yield* Stream.runCollect(session.prompt("Hi"));

      expect(order).toEqual(["handler", "postTool", "validator"]);
      expect([...events]).toContainEqual({
        type: "tool-result",
        id: "call-1",
        name: "echo",
        result: "validated",
        isFailure: false,
      });
    }),
  );

  it.effect("runs post-Tool Hooks for dynamic Tool failures", () =>
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
      const definition: AgentDefinition = {
        providers: [fixture.provider],
        model: "test/default",
        extensions: [
          {
            name: "observe",
            hooks: {
              postTool: () =>
                Effect.sync(() => {
                  postCalls += 1;
                  return { code: "transformed" };
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
        result: { code: "transformed" },
      });
      expect(postCalls).toBe(1);
      // The transformed payload is what the model receives on the next Step.
      const toolMessage = fixture.prompt()?.content.find((message) => message.role === "tool");
      expect(JSON.stringify(toolMessage)).toContain("transformed");
      expect(events.at(-1)).toEqual({ type: "response-complete" });
    }),
  );

  it.effect("transforms a Core-native Tool failure without running its success validator", () =>
    Effect.gen(function* () {
      const fixture = makeToolModel();
      let validatorCalls = 0;
      const echo = Tool.make("echo", {
        parameters: Schema.Struct({ text: Schema.String }),
        success: Schema.String,
        failure: Schema.Struct({ code: Schema.String }),
        failureMode: "return",
      });
      const definition: AgentDefinition = {
        providers: [fixture.provider],
        model: "test/default",
        extensions: [
          {
            name: "transform",
            hooks: {
              postTool: ({ isFailure }) =>
                Effect.succeed({ code: isFailure ? "transformed" : "unexpected" }),
            },
          },
          {
            name: "echo",
            toolkit: Toolkit.make(echo),
            handlers: { echo: () => Effect.fail({ code: "expected" }) },
            toolResultValidators: {
              echo: (result) =>
                Effect.sync(() => {
                  validatorCalls += 1;
                  return result;
                }),
            },
          },
        ],
      };

      const session = yield* createSession(definition);
      const events = yield* Stream.runCollect(session.prompt("Hi"));

      expect([...events]).toContainEqual({
        type: "tool-result",
        id: "call-1",
        name: "echo",
        result: { code: "transformed" },
        isFailure: true,
      });
      expect(validatorCalls).toBe(0);
      expect(events.at(-1)).toEqual({ type: "response-complete" });
      expect(fixture.calls()).toBe(2);
    }),
  );
});
