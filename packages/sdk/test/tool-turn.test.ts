import { describe, expect, test } from "vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import { AiError, LanguageModel } from "effect/unstable/ai";
import { makeProvider } from "@mitome/core";
import {
  AgentDefinitionError,
  defineAgent,
  defineExtension,
  fail,
  withSession,
  type InputSchema,
} from "../src/index.js";
import { jsonStringSchema, makeToolModel, stringSchema } from "./provider.js";

describe("@mitome/sdk Tool", () => {
  test("returns every input validation issue to the model without executing the Tool", async () => {
    const inputSchema: InputSchema<unknown> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => ({
          issues: [
            { message: "name is required", path: ["user", "name"] },
            { message: "tag is invalid", path: [{ key: "tags" }, 0] },
          ],
        }),
        jsonSchema: {
          input: () => ({ type: "object" }),
          output: () => ({ type: "object" }),
        },
      },
    };
    let modelCalls = 0;
    let preToolCalls = 0;
    let handlerCalls = 0;
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
                    name: "validate",
                    params: {},
                  }
                : { type: "text-delta" as const, id: "done", delta: "done" },
            );
          },
        }),
      ),
    );
    const definition = defineAgent({
      providers: [provider],
      model: "test/default",
      extensions: [
        defineExtension({
          name: "validation",
          tools: ({ tool }) => [
            tool({
              name: "validate",
              inputSchema,
              outputSchema: stringSchema,
              handler: async () => {
                handlerCalls += 1;
                return "unused";
              },
            }),
          ],
          hooks: {
            preTool: async () => {
              preToolCalls += 1;
            },
          },
        }),
      ],
    });

    const events = await withSession(definition, (session) =>
      Array.fromAsync(session.runTurn("Hi")),
    );

    expect(events).toEqual([
      { type: "tool-call", id: "call-1", name: "validate", params: {} },
      {
        type: "tool-result",
        id: "call-1",
        name: "validate",
        result: {
          type: "execution-denied",
          reason:
            "Tool input validation failed: user.name: name is required; tags.0: tag is invalid",
        },
        isFailure: true,
      },
      { type: "model-output", text: "done" },
      { type: "response-complete" },
    ]);
    expect({ modelCalls, preToolCalls, handlerCalls }).toEqual({
      modelCalls: 2,
      preToolCalls: 0,
      handlerCalls: 0,
    });
  });

  test("validates Tool input/output and completes a second Step", async () => {
    const fixture = makeToolModel();
    const definition = defineAgent({
      providers: [fixture.provider],
      model: "test/default",
      extensions: [
        defineExtension({
          name: "echo-extension",
          tools: ({ tool }) => [
            tool({
              name: "echo",
              inputSchema: jsonStringSchema,
              outputSchema: stringSchema,
              handler: async (input) => input.toUpperCase(),
            }),
          ],
        }),
      ],
    });

    const events = await withSession(definition, async (session) => {
      const collected = [];
      for await (const event of session.runTurn("Hi")) collected.push(event);
      return collected;
    });

    expect(events).toEqual([
      { type: "tool-call", id: "call-1", name: "echo", params: "hello" },
      { type: "tool-result", id: "call-1", name: "echo", result: "HELLO", isFailure: false },
      { type: "model-output", text: "done" },
      { type: "response-complete" },
    ]);
    expect(fixture.calls()).toBe(2);
    expect(fixture.prompt()?.content.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
  });

  test("passes through output when outputSchema is omitted", async () => {
    const fixture = makeToolModel();
    const definition = defineAgent({
      providers: [fixture.provider],
      model: "test/default",
      tools: ({ tool }) => [
        tool({
          name: "echo",
          inputSchema: jsonStringSchema,
          handler: async (input) => ({ echoed: input }),
        }),
      ],
    });

    const events = await withSession(definition, (session) =>
      Array.fromAsync(session.runTurn("Hi")),
    );

    expect(events.find((event) => event.type === "tool-result")).toEqual({
      type: "tool-result",
      id: "call-1",
      name: "echo",
      result: { echoed: "hello" },
      isFailure: false,
    });
  });

  test("returns a schema-checked expected failure to the Model", async () => {
    const fixture = makeToolModel();
    const definition = defineAgent({
      providers: [fixture.provider],
      model: "test/default",
      tools: ({ tool }) => [
        tool({
          name: "echo",
          inputSchema: jsonStringSchema,
          outputSchema: stringSchema,
          failureSchema: Schema.Struct({ code: Schema.Literal("NOT_FOUND") }),
          handler: async () => fail({ code: "NOT_FOUND" }),
        }),
      ],
    });

    const events = await withSession(definition, (session) =>
      Array.fromAsync(session.runTurn("Hi")),
    );

    expect(events).toEqual([
      { type: "tool-call", id: "call-1", name: "echo", params: "hello" },
      {
        type: "tool-result",
        id: "call-1",
        name: "echo",
        result: { code: "NOT_FOUND" },
        isFailure: true,
      },
      { type: "model-output", text: "done" },
      { type: "response-complete" },
    ]);
    expect(fixture.prompt()?.content.at(-1)).toMatchObject({
      role: "tool",
      content: [expect.objectContaining({ result: { code: "NOT_FOUND" }, isFailure: true })],
    });
  });

  test("maps an invalid expected-failure payload to an opaque defect", async () => {
    const fixture = makeToolModel();
    // SAFETY: Deliberately violates the declared failure type to exercise runtime schema rejection.
    const invalidFailure = fail({ code: "OTHER" }) as never;
    const definition = defineAgent({
      providers: [fixture.provider],
      model: "test/default",
      tools: ({ tool }) => [
        tool({
          name: "echo",
          inputSchema: jsonStringSchema,
          outputSchema: stringSchema,
          failureSchema: Schema.Struct({ code: Schema.Literal("NOT_FOUND") }),
          handler: async () => invalidFailure,
        }),
      ],
    });

    const events = await withSession(definition, (session) =>
      Array.fromAsync(session.runTurn("Hi")),
    );

    const failure = events.find((event) => event.type === "tool-result");
    expect(failure).toMatchObject({ type: "tool-result", isFailure: true });
    expect(JSON.stringify(failure)).not.toContain("OTHER");
    expect(events.at(-1)).toEqual({ type: "response-complete" });
  });

  test("aborts an active handler when iteration breaks and reuses the Session", async () => {
    const fixture = makeToolModel("echo", 3);
    let handlerCalls = 0;
    const { promise: started, resolve: handlerStarted } = Promise.withResolvers<void>();
    const { promise: aborted, resolve: handlerAborted } = Promise.withResolvers<void>();
    const definition = defineAgent({
      providers: [fixture.provider],
      model: "test/default",
      extensions: [
        defineExtension({
          name: "echo-extension",
          tools: ({ tool }) => [
            tool({
              name: "echo",
              inputSchema: jsonStringSchema,
              outputSchema: stringSchema,
              handler: async (_input, { signal }) => {
                handlerCalls += 1;
                if (handlerCalls === 2) return "second";
                return new Promise((resolve) => {
                  signal.addEventListener(
                    "abort",
                    () => {
                      handlerAborted();
                      resolve("aborted");
                    },
                    { once: true },
                  );
                  handlerStarted();
                });
              },
            }),
          ],
        }),
      ],
    });

    const events = await withSession(definition, async (session) => {
      const iterator = session.runTurn("first")[Symbol.asyncIterator]();
      await iterator.next();
      const pending = iterator.next();
      await started;
      await iterator.return?.();
      await aborted;
      await pending.catch(() => undefined);
      expect(session.history()).toEqual([]);
      const next = [];
      for await (const event of session.runTurn("second")) next.push(event);
      return next;
    });

    expect(fixture.calls()).toBe(3);
    expect(events).toEqual([
      { type: "tool-call", id: "call-2", name: "echo", params: "hello" },
      { type: "tool-result", id: "call-2", name: "echo", result: "second", isFailure: false },
      { type: "model-output", text: "done" },
      { type: "response-complete" },
    ]);
    expect(fixture.prompt()?.content.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
  });

  test("aborts an abandoned iterator's active handler before withSession resolves", async () => {
    const { promise: started, resolve: handlerStarted } = Promise.withResolvers<void>();
    const { promise: aborted, resolve: handlerAborted } = Promise.withResolvers<void>();
    const model = makeToolModel().provider;
    const definition = defineAgent({
      providers: [model],
      model: "test/default",
      extensions: [
        defineExtension({
          name: "echo-extension",
          tools: ({ tool }) => [
            tool({
              name: "echo",
              inputSchema: jsonStringSchema,
              outputSchema: stringSchema,
              handler: async (_input, { signal }) =>
                new Promise((resolve) => {
                  signal.addEventListener(
                    "abort",
                    () => {
                      handlerAborted();
                      resolve("aborted");
                    },
                    { once: true },
                  );
                  handlerStarted();
                }),
            }),
          ],
        }),
      ],
    });
    const order: string[] = [];
    const completion = withSession(definition, async (session) => {
      const iterator = session.runTurn("Hi")[Symbol.asyncIterator]();
      await iterator.next();
      await started;
    }).then(() => order.push("session-resolved"));

    await aborted;
    order.push("handler-aborted");
    await completion;

    expect(order).toEqual(["handler-aborted", "session-resolved"]);
  });

  test("rejects duplicate Tool names within an Extension", () => {
    expect(() =>
      defineExtension({
        name: "duplicate-tools",
        tools: ({ tool }) => [
          tool({
            name: "echo",
            inputSchema: jsonStringSchema,
            outputSchema: stringSchema,
            handler: async (input) => input,
          }),
          tool({
            name: "echo",
            inputSchema: jsonStringSchema,
            outputSchema: stringSchema,
            handler: async (input) => input,
          }),
        ],
      }),
    ).toThrow("Duplicate Tool name: echo");
  });

  test("aggregates duplicate Tool names across Extensions when creating a Session", async () => {
    const fixture = makeToolModel();
    const extension = (name: string) =>
      defineExtension({
        name,
        tools: ({ tool }) => [
          tool({
            name: "echo",
            inputSchema: jsonStringSchema,
            outputSchema: stringSchema,
            handler: async (input) => input,
          }),
        ],
      });
    const definition = defineAgent({
      providers: [fixture.provider],
      model: "test/default",
      extensions: [extension("first"), extension("second")],
    });

    const failure = await withSession(definition, async () => undefined).catch((error) => error);
    expect(failure).toBeInstanceOf(AgentDefinitionError);
    if (!(failure instanceof AgentDefinitionError)) throw failure;
    expect(failure.issues).toContain("Duplicate Tool name: echo");
  });

  test("keeps a thrown error opaque when failureSchema and postTool are present", async () => {
    const fixture = makeToolModel();
    const definition = defineAgent({
      providers: [fixture.provider],
      model: "test/default",
      extensions: [
        defineExtension({
          name: "failing-extension",
          tools: ({ tool }) => [
            tool({
              name: "echo",
              inputSchema: jsonStringSchema,
              outputSchema: stringSchema,
              failureSchema: Schema.Struct({ code: Schema.Literal("NOT_FOUND") }),
              handler: async () => {
                throw new Error("secret");
              },
            }),
          ],
          hooks: {
            postTool: async () => ({ code: "NOT_FOUND" }),
          },
        }),
      ],
    });

    const events = await withSession(definition, async (session) => {
      const collected = [];
      for await (const event of session.runTurn("Hi")) collected.push(event);
      return collected;
    });

    const failure = events.find((event) => event.type === "tool-result");
    expect(failure).toMatchObject({
      type: "tool-result",
      isFailure: true,
      result: { _tag: "AiError", method: "echo", module: "@mitome/sdk" },
    });
    expect(JSON.stringify(failure)).not.toContain("secret");
    expect(JSON.stringify(failure)).not.toContain("NOT_FOUND");
    expect(events.at(-1)).toEqual({ type: "response-complete" });
    expect(fixture.calls()).toBe(2);
  });

  test("schema-checks an expected failure after postTool transforms it into an AiError", async () => {
    const fixture = makeToolModel();
    const definition = defineAgent({
      providers: [fixture.provider],
      model: "test/default",
      extensions: [
        defineExtension({
          tools: ({ tool }) => [
            tool({
              name: "echo",
              inputSchema: jsonStringSchema,
              outputSchema: stringSchema,
              failureSchema: Schema.Struct({ code: Schema.Literal("NOT_FOUND") }),
              handler: async () => fail({ code: "NOT_FOUND" }),
            }),
          ],
          hooks: {
            postTool: async () =>
              AiError.make({
                module: "test",
                method: "postTool",
                reason: new AiError.UnknownError({ description: "not a declared failure" }),
              }),
          },
        }),
      ],
    });

    await expect(
      withSession(definition, (session) => Array.fromAsync(session.runTurn("Hi"))),
    ).rejects.toMatchObject({
      _tag: "TurnError",
      message: expect.stringContaining("Post-Tool result validation failed"),
    });
    expect(fixture.calls()).toBe(1);
  });
});
