import { describe, expect, test } from "vitest";
import { Effect, Schema, Stream } from "effect";
import { Prompt, Response } from "effect/unstable/ai";
import {
  defineAgent,
  definePlugin,
  tool,
  withSession,
  type InputSchema,
  type StandardSchema,
} from "../src/index.js";
import { makeTestModel } from "./model.js";

const stringSchema: StandardSchema<unknown, string> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) =>
      typeof value === "string"
        ? { value, issues: undefined }
        : { issues: [{ message: "expected string" }] },
  },
};

const jsonStringSchema: InputSchema<string> = {
  "~standard": {
    ...stringSchema["~standard"],
    jsonSchema: {
      input: () => ({ type: "string" }),
      output: () => ({ type: "string" }),
    },
  },
};

const makeToolModel = () => {
  let calls = 0;
  let secondPrompt: Prompt.Prompt | undefined;
  const model = makeTestModel((options) => {
    calls += 1;
    if (calls === 2) {
      secondPrompt = options.prompt;
      return Stream.succeed(Response.makePart("text-delta", { id: "second", delta: "done" }));
    }
    const call = Response.makePart("tool-call", {
      id: "call-1",
      name: "echo",
      params: "hello",
      providerExecuted: false,
    });
    return Stream.concat(
      Stream.succeed(call),
      Stream.unwrap(
        options.toolkit!.handle("echo", "hello").pipe(
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
  return { model, calls: () => calls, prompt: () => secondPrompt };
};

describe("@mitome/sdk Tool", () => {
  test("validates Standard Schema input/output and completes a second Step", async () => {
    const fixture = makeToolModel();
    const definition = defineAgent({
      instructions: "Be concise.",
      model: fixture.model,
      plugins: [
        definePlugin({
          name: "echo-plugin",
          tools: [
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
      for await (const event of session.prompt("Hi")) collected.push(event);
      return collected;
    });

    expect(events).toEqual([
      { type: "tool-call", id: "call-1", name: "echo" },
      { type: "tool-result", id: "call-1", name: "echo", result: "HELLO", isFailure: false },
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
  });

  test("aborts an active handler when iteration breaks and reuses the Session", async () => {
    let calls = 0;
    let handlerCalls = 0;
    let secondPrompt: Prompt.Prompt | undefined;
    let handlerStarted!: () => void;
    let handlerAborted!: () => void;
    const started = new Promise<void>((resolve) => (handlerStarted = resolve));
    const aborted = new Promise<void>((resolve) => (handlerAborted = resolve));
    const model = makeTestModel((options) => {
      calls += 1;
      if (calls === 3) {
        return Stream.succeed(Response.makePart("text-delta", { id: "done", delta: "done" }));
      }
      if (calls === 2) secondPrompt = options.prompt;
      const call = Response.makePart("tool-call", {
        id: `call-${calls}`,
        name: "echo",
        params: "hello",
        providerExecuted: false,
      });
      return Stream.concat(
        Stream.succeed(call),
        Stream.unwrap(
          options.toolkit!.handle("echo", "hello").pipe(
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
    const definition = defineAgent({
      instructions: "Be concise.",
      model,
      plugins: [
        definePlugin({
          name: "echo-plugin",
          tools: [
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
      const iterator = session.prompt("first")[Symbol.asyncIterator]();
      await iterator.next();
      const pending = iterator.next();
      await started;
      await iterator.return?.();
      await aborted;
      await pending.catch(() => undefined);
      const next = [];
      for await (const event of session.prompt("second")) next.push(event);
      return next;
    });

    expect(calls).toBe(3);
    expect(events).toEqual([
      { type: "tool-call", id: "call-2", name: "echo" },
      { type: "tool-result", id: "call-2", name: "echo", result: "second", isFailure: false },
      { type: "model-output", text: "done" },
      { type: "response-complete" },
    ]);
    expect(secondPrompt?.content.map((message) => message.role)).toEqual(["system", "user"]);
  });

  test("aborts an abandoned iterator's active handler before withSession resolves", async () => {
    let handlerStarted!: () => void;
    let handlerAborted!: () => void;
    const started = new Promise<void>((resolve) => (handlerStarted = resolve));
    const aborted = new Promise<void>((resolve) => (handlerAborted = resolve));
    const model = makeTestModel((options) => {
      const call = Response.makePart("tool-call", {
        id: "call-1",
        name: "echo",
        params: "hello",
        providerExecuted: false,
      });
      return Stream.concat(
        Stream.succeed(call),
        Stream.unwrap(
          options.toolkit!.handle("echo", "hello").pipe(
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
    const definition = defineAgent({
      instructions: "Be concise.",
      model,
      plugins: [
        definePlugin({
          name: "echo-plugin",
          tools: [
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
      const iterator = session.prompt("Hi")[Symbol.asyncIterator]();
      await iterator.next();
      await started;
    }).then(() => order.push("session-resolved"));

    await aborted;
    order.push("handler-aborted");
    await completion;

    expect(order).toEqual(["handler-aborted", "session-resolved"]);
  });

  test("accepts Effect Schema without manual Standard Schema adapters", async () => {
    const fixture = makeToolModel();
    const definition = defineAgent({
      instructions: "Be concise.",
      model: fixture.model,
      plugins: [
        definePlugin({
          name: "effect-schema",
          tools: [
            tool({
              name: "echo",
              inputSchema: Schema.String,
              outputSchema: Schema.String,
              handler: async (input) => input.toUpperCase(),
            }),
          ],
        }),
      ],
    });

    const events = await withSession(definition, async (session) => {
      const collected = [];
      for await (const event of session.prompt("Hi")) collected.push(event);
      return collected;
    });

    expect(events).toContainEqual({
      type: "tool-result",
      id: "call-1",
      name: "echo",
      result: "HELLO",
      isFailure: false,
    });
  });

  test("rejects duplicate Tool names within a Plugin", () => {
    expect(() =>
      definePlugin({
        name: "duplicate-tools",
        tools: [
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

  test("returns a generic failure result when a Promise handler rejects", async () => {
    const fixture = makeToolModel();
    const definition = defineAgent({
      instructions: "Be concise.",
      model: fixture.model,
      plugins: [
        definePlugin({
          name: "failing-plugin",
          tools: [
            tool({
              name: "echo",
              inputSchema: jsonStringSchema,
              outputSchema: stringSchema,
              handler: async () => Promise.reject(new Error("secret")),
            }),
          ],
        }),
      ],
    });

    const events = await withSession(definition, async (session) => {
      const collected = [];
      for await (const event of session.prompt("Hi")) collected.push(event);
      return collected;
    });

    const failure = events.find((event) => event.type === "tool-result");
    expect(failure).toMatchObject({ type: "tool-result", isFailure: true });
    expect(JSON.stringify(failure)).not.toContain("secret");
    expect(events.at(-1)).toEqual({ type: "response-complete" });
    expect(fixture.calls()).toBe(2);
  });
});
