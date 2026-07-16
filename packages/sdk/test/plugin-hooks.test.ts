import { describe, expect, test } from "vitest";
import { Effect, Stream } from "effect";
import { Response } from "effect/unstable/ai";
import { type Plugin } from "@mitome/core";
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
  return makeTestModel((options) => {
    calls += 1;
    if (calls === 2)
      return Stream.succeed(Response.makePart("text-delta", { id: "done", delta: "done" }));
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
};

describe("@mitome/sdk Plugin Hooks", () => {
  test("adapts Promise Hooks into the Core lifecycle in Agent Definition order", async () => {
    const log: Array<string> = [];
    const signals: Array<boolean> = [];
    const model = makeToolModel();
    const core: Plugin = {
      name: "core",
      hooks: {
        sessionStart: Effect.sync(() => void log.push("core:session-start")),
        turnStart: () => Effect.sync(() => void log.push("core:turn-start")),
        stepStart: () => Effect.sync(() => void log.push("core:step-start")),
        preStep: (prompt) => Effect.sync(() => (log.push("core:pre-step"), prompt)),
        preTool: () => Effect.sync(() => void log.push("core:pre-tool")),
        postTool: ({ result }) => Effect.sync(() => (log.push("core:post-tool"), result)),
      },
    };
    const sdk = definePlugin({
      name: "sdk",
      tools: [
        tool({
          name: "echo",
          inputSchema: jsonStringSchema,
          outputSchema: stringSchema,
          handler: async (input) => input,
        }),
      ],
      hooks: {
        sessionStart: async ({ signal }) => {
          signals.push(signal.aborted);
          log.push("sdk:session-start");
        },
        turnStart: async (_text, { signal }) => {
          signals.push(signal.aborted);
          log.push("sdk:turn-start");
        },
        stepStart: async (_prompt, { signal }) => {
          signals.push(signal.aborted);
          log.push("sdk:step-start");
        },
        preStep: async (prompt, { signal }) => {
          signals.push(signal.aborted);
          log.push("sdk:pre-step");
          return prompt;
        },
        preTool: async ({ signal }) => {
          signals.push(signal.aborted);
          log.push("sdk:pre-tool");
        },
        postTool: async ({ result, signal }) => {
          signals.push(signal.aborted);
          log.push("sdk:post-tool");
          return `${String(result)}!`;
        },
      },
    });

    const events = await withSession(
      defineAgent({ instructions: "Be concise.", model, plugins: [core, sdk] }),
      (session) => Array.fromAsync(session.prompt("Hi")),
    );

    expect(log).toEqual([
      "core:session-start",
      "sdk:session-start",
      "core:turn-start",
      "sdk:turn-start",
      "core:step-start",
      "sdk:step-start",
      "core:pre-step",
      "sdk:pre-step",
      "core:pre-tool",
      "sdk:pre-tool",
      "core:post-tool",
      "sdk:post-tool",
      "core:step-start",
      "sdk:step-start",
      "core:pre-step",
      "sdk:pre-step",
    ]);
    expect(signals).toHaveLength(8);
    expect(signals.every((aborted) => !aborted)).toBe(true);
    expect(events).toContainEqual({
      type: "tool-result",
      id: "call-1",
      name: "echo",
      result: "hello!",
      isFailure: false,
    });
  });

  test("rejects invalid pre-Step output before calling the model", async () => {
    let modelCalls = 0;
    const agent = defineAgent({
      instructions: "Be concise.",
      model: makeTestModel(() => {
        modelCalls += 1;
        return Stream.succeed(Response.makePart("text-delta", { id: "done", delta: "done" }));
      }),
      plugins: [
        definePlugin({
          name: "sdk",
          tools: [],
          hooks: { preStep: async () => undefined as never },
        }),
      ],
    });

    await expect(
      withSession(agent, (session) => Array.fromAsync(session.prompt("Hi"))),
    ).rejects.toMatchObject({ _tag: "TurnError", message: "Pre-Step Hook failed" });
    expect(modelCalls).toBe(0);
  });

  test("aborts an in-flight Promise Hook when iteration stops", async () => {
    let started!: () => void;
    const hookStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted = false;
    const agent = defineAgent({
      instructions: "Be concise.",
      model: makeToolModel(),
      plugins: [
        definePlugin({
          name: "sdk",
          tools: [],
          hooks: {
            preStep: (_prompt, { signal }) =>
              new Promise((_resolve, reject) => {
                started();
                signal.addEventListener(
                  "abort",
                  () => {
                    aborted = signal.aborted;
                    reject(new Error("aborted"));
                  },
                  { once: true },
                );
              }),
          },
        }),
      ],
    });

    await withSession(agent, async (session) => {
      const iterator = session.prompt("Hi")[Symbol.asyncIterator]();
      const next = iterator.next();
      await hookStarted;
      await iterator.return?.();
      await next;
    });

    expect(aborted).toBe(true);
  });

  test("continues remaining end Hooks when iteration stops during cleanup", async () => {
    let started!: () => void;
    const hookStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted = false;
    let laterCompleted = false;
    const agent = defineAgent({
      instructions: "Be concise.",
      model: makeTestModel(() =>
        Stream.succeed(Response.makePart("text-delta", { id: "done", delta: "done" })),
      ),
      plugins: [
        definePlugin({
          name: "blocking",
          tools: [],
          hooks: {
            stepEnd: (_prompt, { signal }) =>
              new Promise((_resolve, reject) => {
                started();
                signal.addEventListener(
                  "abort",
                  () => {
                    aborted = signal.aborted;
                    reject(new Error("aborted"));
                  },
                  { once: true },
                );
              }),
          },
        }),
        definePlugin({
          name: "later",
          tools: [],
          hooks: {
            stepEnd: async () => {
              laterCompleted = true;
            },
          },
        }),
      ],
    });

    await withSession(agent, async (session) => {
      const iterator = session.prompt("Hi")[Symbol.asyncIterator]();
      expect(await iterator.next()).toMatchObject({ value: { type: "model-output" } });
      await hookStarted;
      await iterator.return?.();
    });

    expect({ aborted, laterCompleted }).toEqual({ aborted: true, laterCompleted: true });
  });

  test("preserves the original rejected Hook error as the TurnError cause", async () => {
    const original = new Error("hook failed");
    const agent = defineAgent({
      instructions: "Be concise.",
      model: makeTestModel(() =>
        Stream.succeed(Response.makePart("text-delta", { id: "done", delta: "done" })),
      ),
      plugins: [
        definePlugin({
          name: "sdk",
          tools: [],
          hooks: { turnStart: async () => Promise.reject(original) },
        }),
      ],
    });

    await expect(
      withSession(agent, (session) => Array.fromAsync(session.prompt("Hi"))),
    ).rejects.toMatchObject({ _tag: "TurnError", cause: original });
  });

  test("centrally validates any Plugin's SDK Tool transform and preserves SDK failures", async () => {
    let postCalls = 0;
    const core: Plugin = {
      name: "core",
      hooks: {
        postTool: ({ result }) =>
          Effect.sync(() => {
            postCalls += 1;
            return result;
          }),
      },
    };
    const failing = defineAgent({
      instructions: "Be concise.",
      model: makeToolModel(),
      plugins: [
        core,
        definePlugin({
          name: "sdk",
          tools: [
            tool({
              name: "echo",
              inputSchema: jsonStringSchema,
              outputSchema: stringSchema,
              handler: async () => Promise.reject(new Error("expected")),
            }),
          ],
        }),
      ],
    });
    const events = await withSession(failing, (session) => Array.fromAsync(session.prompt("Hi")));
    expect(events.find((event) => event.type === "tool-result")).toMatchObject({
      type: "tool-result",
      isFailure: true,
    });
    expect(postCalls).toBe(0);
    expect(events.at(-1)).toEqual({ type: "response-complete" });

    const invalid = defineAgent({
      instructions: "Be concise.",
      model: makeToolModel(),
      plugins: [
        { name: "core", hooks: { postTool: () => Effect.succeed(1) } },
        definePlugin({
          name: "sdk",
          tools: [
            tool({
              name: "echo",
              inputSchema: jsonStringSchema,
              outputSchema: stringSchema,
              handler: async (input) => input,
            }),
          ],
        }),
      ],
    });
    await expect(
      withSession(invalid, (session) => Array.fromAsync(session.prompt("Hi"))),
    ).rejects.toMatchObject({ _tag: "TurnError" });
  });
});
