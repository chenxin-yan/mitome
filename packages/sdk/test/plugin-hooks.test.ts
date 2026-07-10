import { describe, expect, test } from "bun:test";
import { Effect, Layer, Stream } from "effect";
import { LanguageModel, Response, Toolkit } from "effect/unstable/ai";
import { makeModel, type Plugin } from "@mitome/core";
import {
  TurnError,
  defineAgent,
  definePlugin,
  tool,
  withSession,
  type InputSchema,
  type StandardSchema,
} from "@mitome/sdk";

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
  return makeModel(
    Layer.succeed(LanguageModel.LanguageModel, {
      streamText: (options: { readonly toolkit?: Toolkit.WithHandler<any> }) => {
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
      },
    } as LanguageModel.Service),
  );
};

describe("@mitome/sdk Plugin Hooks", () => {
  test("adapts Promise Hooks into the Core lifecycle in Definition order", async () => {
    const log: Array<string> = [];
    const signals: Array<boolean> = [];
    let calls = 0;
    const model = makeModel(
      Layer.succeed(LanguageModel.LanguageModel, {
        streamText: (options: { readonly toolkit?: Toolkit.WithHandler<any> }) => {
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
        },
      } as LanguageModel.Service),
    );
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
      async (session) => {
        const collected = [];
        for await (const event of session.prompt("Hi")) collected.push(event);
        return collected;
      },
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
    expect(signals).toEqual(Array(signals.length).fill(false));
    expect(events).toContainEqual({
      type: "tool-result",
      id: "call-1",
      name: "echo",
      result: "hello!",
      isFailure: false,
    });
  });

  test("preserves the original rejected Hook error as the TurnError cause", async () => {
    const original = new Error("hook failed");
    const agent = defineAgent({
      instructions: "Be concise.",
      model: makeModel(
        Layer.succeed(LanguageModel.LanguageModel, {
          streamText: () =>
            Stream.succeed(Response.makePart("text-delta", { id: "done", delta: "done" })),
        } as LanguageModel.Service),
      ),
      plugins: [
        definePlugin({
          name: "sdk",
          tools: [],
          hooks: { turnStart: async () => Promise.reject(original) },
        }),
      ],
    });

    let failure: unknown;
    try {
      await withSession(agent, async (session) => {
        for await (const _event of session.prompt("Hi")) {
          // The rejected Hook fails before the model emits an event.
        }
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(TurnError);
    expect((failure as TurnError).cause).toBe(original);
  });

  test("centrally validates any Plugin's SDK Tool transform and preserves SDK failures", async () => {
    const core: Plugin = {
      name: "core",
      hooks: { postTool: ({ result }) => Effect.succeed(result) },
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
    const events = await withSession(failing, async (session) => {
      const collected = [];
      for await (const event of session.prompt("Hi")) collected.push(event);
      return collected;
    });
    expect(events.find((event) => event.type === "tool-result")).toMatchObject({
      type: "tool-result",
      isFailure: true,
    });
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
      withSession(invalid, async (session) => {
        for await (const _event of session.prompt("Hi")) {
          // The invalid post-Tool value fails before a result can be emitted.
        }
      }),
    ).rejects.toMatchObject({ _tag: "TurnError" });
  });
});
