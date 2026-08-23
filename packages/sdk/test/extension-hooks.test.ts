import { describe, expect, test } from "vitest";
import { Context, Effect, Layer, Stream } from "effect";
import { Response } from "effect/unstable/ai";
import { defineAgent, defineExtension, tool, withSession, type Extension } from "../src/index.js";
import { jsonStringSchema, makeTestProvider, makeToolModel, stringSchema } from "./provider.js";

const textModel = () =>
  makeTestProvider(() =>
    Stream.succeed(Response.makePart("text-delta", { id: "done", delta: "done" })),
  );

describe("@mitome/sdk Extension Hooks", () => {
  test("runs auto-included dependencies once in dependency-first Hook and Instructions order", async () => {
    const log: Array<string> = [];
    const extension = (name: string, dependencies: ReadonlyArray<Extension> = []): Extension => ({
      name,
      dependencies,
      instructions: name,
      hooks: { sessionStart: Effect.sync(() => void log.push(name)) },
    });
    const shared = extension("shared");
    const first = extension("first", [shared]);
    const second = extension("second", [shared]);
    const root = extension("root", [first, second]);

    const instructions = await withSession(
      defineAgent({ providers: [textModel()], model: "test/default", extensions: [root] }),
      async (session) => session.history()[0]?.content,
    );

    expect(log).toEqual(["shared", "first", "second", "root"]);
    expect(instructions).toBe("shared\n\nfirst\n\nsecond\n\nroot");
  });

  test("shares one published service instance and releases dependents before it", async () => {
    class Shared extends Context.Service<Shared, { count: number }>()("test/Shared") {}
    class First extends Context.Service<First, { readonly count: number }>()("test/First") {}
    class Second extends Context.Service<Second, { readonly count: number }>()("test/Second") {}

    const log: Array<string> = [];
    const observed: Array<{ count: number }> = [];
    const shared: Extension<
      Shared,
      never,
      Readonly<Record<never, never>>,
      readonly [typeof Shared]
    > = {
      name: "shared",
      provides: [Shared],
      resource: Layer.effect(
        Shared,
        Effect.acquireRelease(
          Effect.sync(() => ({ count: 0 })),
          () => Effect.sync(() => void log.push("dispose:shared")),
        ),
      ),
    };
    const dependent = <Service extends First | Second>(
      name: string,
      service: Context.Service<Service, { readonly count: number }>,
    ): Extension<Service> => ({
      name,
      dependencies: [shared],
      resource: Layer.effect(
        service,
        Effect.acquireRelease(
          Effect.map(Shared, (instance) => {
            observed.push(instance);
            instance.count += 1;
            return { count: instance.count };
          }),
          () => Effect.sync(() => void log.push(`dispose:${name}`)),
        ),
      ),
    });
    const first = dependent("first", First);
    const second = dependent("second", Second);

    await withSession(
      defineAgent({ providers: [textModel()], model: "test/default", extensions: [first, second] }),
      async () => {},
    );

    expect(observed).toHaveLength(2);
    expect(observed[0]).toBe(observed[1]);
    expect(observed[0]?.count).toBe(2);
    expect(log).toEqual(["dispose:second", "dispose:first", "dispose:shared"]);
  });

  test("keeps unpublished dependency services private at runtime", async () => {
    class Public extends Context.Service<Public, { readonly value: string }>()("test/Public") {}
    class Private extends Context.Service<Private, { readonly value: string }>()("test/Private") {}
    const dependency: Extension<Public | Private> = {
      name: "dependency",
      provides: [Public],
      resource: Layer.merge(
        Layer.succeed(Public, { value: "public" }),
        Layer.succeed(Private, { value: "private" }),
      ),
    };
    const dependent: Extension<Private> = {
      name: "dependent",
      dependencies: [dependency],
      hooks: { sessionStart: Effect.asVoid(Private) },
    };

    await expect(
      withSession(
        defineAgent({ providers: [textModel()], model: "test/default", extensions: [dependent] }),
        async () => {},
      ),
    ).rejects.toThrow("Service not found: test/Private");
  });

  test("defineExtension dependencies acquire dependency-first and dispose dependent-first", async () => {
    const log: Array<string> = [];
    const dependency = defineExtension({
      name: "dependency",
      tools: [],
      setup: async () => void log.push("setup:dependency"),
      dispose: async () => void log.push("dispose:dependency"),
    });
    const root = defineExtension({
      name: "root",
      dependencies: [dependency],
      tools: [],
      setup: async () => void log.push("setup:root"),
      dispose: async () => void log.push("dispose:root"),
    });

    await withSession(
      defineAgent({ providers: [textModel()], model: "test/default", extensions: [root] }),
      async () => {},
    );

    expect(log).toEqual(["setup:dependency", "setup:root", "dispose:root", "dispose:dependency"]);
  });

  test("adapts Promise Hooks into the Core lifecycle in Agent Definition order", async () => {
    const log: Array<string> = [];
    const signals: Array<boolean> = [];
    const responsePartTypes: Array<ReadonlyArray<string>> = [];
    const model = makeToolModel().provider;
    const core: Extension = {
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
    const sdk = defineExtension({
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
        stepEnd: async (_prompt, { responseParts, signal }) => {
          signals.push(signal.aborted);
          responsePartTypes.push(responseParts.map((part) => part.type));
          log.push("sdk:step-end");
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
      defineAgent({ providers: [model], model: "test/default", extensions: [core, sdk] }),
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
      "sdk:step-end",
      "core:step-start",
      "sdk:step-start",
      "core:pre-step",
      "sdk:pre-step",
      "sdk:step-end",
    ]);
    expect(signals).toHaveLength(10);
    expect(signals.every((aborted) => !aborted)).toBe(true);
    expect(responsePartTypes).toEqual([["tool-call", "tool-result"], ["text-delta"]]);
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
      providers: [
        makeTestProvider(() => {
          modelCalls += 1;
          return Stream.succeed(Response.makePart("text-delta", { id: "done", delta: "done" }));
        }),
      ],
      model: "test/default",
      extensions: [
        defineExtension({
          name: "sdk",
          tools: [],
          hooks: {
            // SAFETY: This test deliberately violates the Hook's runtime output contract to verify
            // that SDK boundary validation rejects an invalid Promise Hook result.
            preStep: async () => undefined as never,
          },
        }),
      ],
    });

    await expect(
      withSession(agent, (session) => Array.fromAsync(session.prompt("Hi"))),
    ).rejects.toMatchObject({ _tag: "TurnError", message: "Pre-Step Hook failed" });
    expect(modelCalls).toBe(0);
  });

  test("aborts an in-flight Promise Hook when iteration stops", async () => {
    const { promise: hookStarted, resolve: started } = Promise.withResolvers<void>();
    let aborted = false;
    const agent = defineAgent({
      providers: [makeToolModel().provider],
      model: "test/default",
      extensions: [
        defineExtension({
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
    const { promise: hookStarted, resolve: started } = Promise.withResolvers<void>();
    let aborted = false;
    let laterCompleted = false;
    const agent = defineAgent({
      providers: [
        makeTestProvider(() =>
          Stream.succeed(Response.makePart("text-delta", { id: "done", delta: "done" })),
        ),
      ],
      model: "test/default",
      extensions: [
        defineExtension({
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
        defineExtension({
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
      providers: [
        makeTestProvider(() =>
          Stream.succeed(Response.makePart("text-delta", { id: "done", delta: "done" })),
        ),
      ],
      model: "test/default",
      extensions: [
        defineExtension({
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

  test("centrally validates SDK Tool transforms and observes SDK failures", async () => {
    let postCalls = 0;
    const core: Extension = {
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
      providers: [makeToolModel().provider],
      model: "test/default",
      extensions: [
        core,
        defineExtension({
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
    expect(postCalls).toBe(1);
    expect(events.at(-1)).toEqual({ type: "response-complete" });

    const invalid = defineAgent({
      providers: [makeToolModel().provider],
      model: "test/default",
      extensions: [
        { name: "core", hooks: { postTool: () => Effect.succeed(1) } },
        defineExtension({
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
