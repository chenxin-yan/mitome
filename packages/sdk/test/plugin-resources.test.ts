import { describe, expect, test } from "vitest";
import { Cause, Context, Effect, Exit, Layer, Result, Schema, SchemaGetter, Stream } from "effect";
import { Response, Tool as AiTool, Toolkit } from "effect/unstable/ai";
import { createSession, type Plugin } from "@mitome/core";
import { jsonStringSchema, makeTestProvider, makeToolModel, stringSchema } from "./provider.js";
import { defineAgent, definePlugin, tool, withSession } from "../src/index.js";

const textModel = () =>
  makeTestProvider(() =>
    Stream.succeed(Response.makePart("text-delta", { id: "done", delta: "done" })),
  );

describe("@mitome/sdk Plugin resources", () => {
  test("acquires resources before sessionStart in Agent Definition order and disposes them in reverse", async () => {
    const log: Array<string> = [];
    const plugin = (name: string) =>
      definePlugin({
        name,
        tools: [],
        setup: async () => {
          log.push(`setup:${name}`);
          return name;
        },
        dispose: async (resource) => {
          log.push(`dispose:${resource}`);
        },
        hooks: {
          sessionStart: async ({ resource }) => {
            log.push(`start:${resource}`);
          },
        },
      });

    await withSession(
      defineAgent({
        providers: [textModel()],
        model: "test/default",
        plugins: [plugin("first"), plugin("second"), plugin("third")],
      }),
      (session) => Array.fromAsync(session.prompt("Hi")),
    );

    expect(log).toEqual([
      "setup:first",
      "setup:second",
      "setup:third",
      "start:first",
      "start:second",
      "start:third",
      "dispose:third",
      "dispose:second",
      "dispose:first",
    ]);
  });

  test("cleans acquired resources before setup and startup Hook failures escape", async () => {
    const setupFailure = new Error("setup failed");
    const hookFailure = new Error("hook failed");
    const setupLog: Array<string> = [];
    const first = definePlugin({
      name: "first",
      tools: [],
      setup: async () => {
        setupLog.push("setup:first");
        return "first";
      },
      dispose: async (resource) => {
        setupLog.push(`dispose:${resource}`);
      },
    });
    const second = definePlugin({
      name: "second",
      tools: [],
      setup: async (): Promise<string> => {
        setupLog.push("setup:second");
        throw setupFailure;
      },
    });

    await expect(
      withSession(
        defineAgent({ providers: [textModel()], model: "test/default", plugins: [first, second] }),
        async () => undefined,
      ),
    ).rejects.toMatchObject({ _tag: "TurnError", cause: setupFailure });
    expect(setupLog).toEqual(["setup:first", "setup:second", "dispose:first"]);

    const hookLog: Array<string> = [];
    const plugin = (name: string, fail = false) =>
      definePlugin({
        name,
        tools: [],
        setup: async () => {
          hookLog.push(`setup:${name}`);
          return name;
        },
        dispose: async (resource) => {
          hookLog.push(`dispose:${resource}`);
        },
        hooks: {
          sessionStart: async ({ resource }) => {
            hookLog.push(`start:${resource}`);
            if (fail) throw hookFailure;
          },
        },
      });
    await expect(
      withSession(
        defineAgent({
          providers: [textModel()],
          model: "test/default",
          plugins: [plugin("first"), plugin("second", true)],
        }),
        async () => undefined,
      ),
    ).rejects.toMatchObject({ _tag: "TurnError", cause: hookFailure });
    expect(hookLog).toEqual([
      "setup:first",
      "setup:second",
      "start:first",
      "start:second",
      "dispose:second",
      "dispose:first",
    ]);
  });

  test("provides each Plugin only its own resource to Hooks and Tool handlers", async () => {
    const log: Array<string> = [];
    const alpha = definePlugin({
      name: "alpha",
      tools: [
        tool<string, string, { readonly name: string; readonly count: number }>({
          name: "alpha-tool",
          inputSchema: jsonStringSchema,
          outputSchema: stringSchema,
          handler: async (input, { resource }) => {
            const count: number = resource.count;
            log.push(`tool:${resource.name}:${count}`);
            return input;
          },
        }),
      ],
      setup: async () => ({ name: "alpha", count: 1 }),
    });
    const beta = definePlugin({
      name: "beta",
      tools: [],
      setup: async () => ({ name: "beta", enabled: true }),
      hooks: {
        sessionStart: async ({ resource }) => {
          const enabled: boolean = resource.enabled;
          log.push(`hook:${resource.name}:${enabled}`);
        },
      },
    });

    const events = await withSession(
      defineAgent({
        providers: [makeToolModel("alpha-tool").provider],
        model: "test/default",
        plugins: [alpha, beta],
      }),
      (session) => Array.fromAsync(session.prompt("Hi")),
    );

    expect(log).toEqual(["hook:beta:true", "tool:alpha:1"]);
    expect(events).toContainEqual({
      type: "tool-result",
      id: "call-1",
      name: "alpha-tool",
      result: "hello",
      isFailure: false,
    });
  });

  test("provides the resource to every Hook and disposes after sessionEnd", async () => {
    const log: Array<string> = [];
    const plugin = definePlugin({
      name: "all-hooks",
      tools: [
        tool<string, string, string>({
          name: "res-tool",
          inputSchema: jsonStringSchema,
          outputSchema: stringSchema,
          handler: async (input, { resource }) => {
            log.push(`tool:${resource}`);
            return input;
          },
        }),
      ],
      setup: async () => {
        log.push("setup");
        return "res";
      },
      dispose: async (resource) => {
        log.push(`dispose:${resource}`);
      },
      hooks: {
        sessionStart: async ({ resource }) => void log.push(`sessionStart:${resource}`),
        sessionEnd: async ({ resource }) => void log.push(`sessionEnd:${resource}`),
        turnStart: async (_text, { resource }) => void log.push(`turnStart:${resource}`),
        turnEnd: async (_text, { resource }) => void log.push(`turnEnd:${resource}`),
        stepStart: async (_prompt, { resource }) => void log.push(`stepStart:${resource}`),
        stepEnd: async (_prompt, { resource }) => void log.push(`stepEnd:${resource}`),
        preStep: async (prompt, { resource }) => {
          log.push(`preStep:${resource}`);
          return prompt;
        },
        preTool: async ({ resource }) => void log.push(`preTool:${resource}`),
        postTool: async ({ result, resource }) => {
          log.push(`postTool:${resource}`);
          return result;
        },
      },
    });

    await withSession(
      defineAgent({
        providers: [makeToolModel("res-tool").provider],
        model: "test/default",
        plugins: [plugin],
      }),
      (session) => Array.fromAsync(session.prompt("Hi")),
    );

    expect(log).toEqual([
      "setup",
      "sessionStart:res",
      "turnStart:res",
      "stepStart:res",
      "preStep:res",
      "preTool:res",
      "tool:res",
      "postTool:res",
      "stepEnd:res",
      "stepStart:res",
      "preStep:res",
      "stepEnd:res",
      "turnEnd:res",
      "sessionEnd:res",
      "dispose:res",
    ]);
  });

  test("does not expose one core Plugin's resource to another", async () => {
    const Owned = Context.Service<string>("test/Owned");
    const Intruding = Context.Service<string>("test/Intruding");
    const owner: Plugin<string> = {
      name: "owner",
      resource: Layer.succeed(Owned, "owned"),
    };
    // Both tags share the identifier type, so this compiles as Plugin<string>;
    // only runtime per-plugin context isolation can reject the foreign lookup.
    const intruder: Plugin<string> = {
      name: "intruder",
      resource: Layer.succeed(Intruding, "intruding"),
      hooks: { sessionStart: Effect.asVoid(Effect.service(Owned)) },
    };

    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          createSession(
            defineAgent({
              providers: [textModel()],
              model: "test/default",
              plugins: [owner, intruder],
            }),
          ),
        ),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("keeps a resource live across Turn cancellation and passes the Session AbortSignal", async () => {
    const { promise: handlerStarted, resolve: started } = Promise.withResolvers<void>();
    const { promise: handlerAborted, resolve: aborted } = Promise.withResolvers<void>();
    const model = makeToolModel("wait", 3).provider;
    let disposed = 0;
    const definition = defineAgent({
      providers: [model],
      model: "test/default",
      plugins: [
        definePlugin({
          name: "wait",
          tools: [
            tool<string, string, { readonly wait: (signal: AbortSignal) => Promise<string> }>({
              name: "wait",
              inputSchema: jsonStringSchema,
              outputSchema: stringSchema,
              handler: async (_input, { resource, signal }) => resource.wait(signal),
            }),
          ],
          setup: async () => {
            let waits = 0;
            return {
              wait: (signal: AbortSignal) => {
                waits += 1;
                if (waits === 2) return Promise.resolve("second");
                return new Promise<string>((resolve) => {
                  signal.addEventListener(
                    "abort",
                    () => {
                      aborted();
                      resolve("aborted");
                    },
                    { once: true },
                  );
                  started();
                });
              },
            };
          },
          dispose: async () => {
            disposed += 1;
          },
        }),
      ],
    });

    const events = await withSession(definition, async (session) => {
      const iterator = session.prompt("first")[Symbol.asyncIterator]();
      await iterator.next();
      const pending = iterator.next();
      await handlerStarted;
      await iterator.return?.();
      await handlerAborted;
      await pending.catch(() => undefined);
      return Array.fromAsync(session.prompt("second"));
    });

    expect(events.at(-1)).toEqual({ type: "response-complete" });
    expect(disposed).toBe(1);
  });

  test("mixes an Effect-native resource Plugin with an SDK resource Plugin", async () => {
    const log: Array<string> = [];
    const CoreResource = Context.Service<string>("test/CoreResource");
    const core: Plugin<string> = {
      name: "core",
      resource: Layer.effect(
        CoreResource,
        Effect.acquireRelease(
          Effect.sync(() => {
            log.push("setup:core");
            return "core";
          }),
          (resource) => Effect.sync(() => void log.push(`dispose:${resource}`)),
        ),
      ),
      hooks: {
        sessionStart: Effect.service(CoreResource).pipe(
          Effect.tap((resource) => Effect.sync(() => void log.push(`start:${resource}`))),
          Effect.asVoid,
        ),
      },
    };
    const sdk = definePlugin({
      name: "sdk",
      tools: [],
      setup: async () => {
        log.push("setup:sdk");
        return "sdk";
      },
      dispose: async (resource) => {
        log.push(`dispose:${resource}`);
      },
      hooks: { sessionStart: async ({ resource }) => void log.push(`start:${resource}`) },
    });

    await withSession(
      defineAgent({ providers: [textModel()], model: "test/default", plugins: [core, sdk] }),
      async () => undefined,
    );
    expect(log).toEqual([
      "setup:core",
      "setup:sdk",
      "start:core",
      "start:sdk",
      "dispose:sdk",
      "dispose:core",
    ]);
  });

  test("provides the owning Plugin's resource to native Tool schema encoding", async () => {
    const Prefix = Context.Service<string>("test/Prefix");
    // Success schema whose encoding requires the Prefix service from the Plugin resource.
    const serviceString = Schema.String.pipe(
      Schema.decodeTo(Schema.String, {
        decode: SchemaGetter.transformOrFail((value: string) =>
          Effect.map(Effect.service(Prefix), (prefix) => `${prefix}:${value}`),
        ),
        encode: SchemaGetter.transformOrFail((value: string) =>
          Effect.map(Effect.service(Prefix), (prefix) => `${prefix}:${value}`),
        ),
      }),
    );
    const echo = AiTool.make("native-echo", {
      parameters: Schema.Struct({ text: Schema.String }),
      success: serviceString,
      failureMode: "return",
    });
    const native: Plugin<string> = {
      name: "native",
      resource: Layer.succeed(Prefix, "pre"),
      toolkit: Toolkit.make(echo),
      handlers: { "native-echo": () => Effect.succeed("hello") },
      // postTool forces the validateResult re-encoding path as well.
      hooks: { postTool: (context) => Effect.succeed(context.result) },
    };
    let calls = 0;
    const model = makeTestProvider((options) => {
      calls += 1;
      if (calls === 2)
        return Stream.succeed(Response.makePart("text-delta", { id: "done", delta: "done" }));
      const call = Response.makePart("tool-call", {
        id: "call-1",
        name: "native-echo",
        params: { text: "hi" },
        providerExecuted: false,
      });
      return Stream.concat(
        Stream.succeed(call),
        Stream.unwrap(
          options.toolkit!.handle("native-echo", { text: "hi" }).pipe(
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

    const events = await withSession(
      defineAgent({ providers: [model], model: "test/default", plugins: [native] }),
      (session) => Array.fromAsync(session.prompt("Hi")),
    );

    expect(events).toContainEqual({
      type: "tool-result",
      id: "call-1",
      name: "native-echo",
      result: "hello",
      isFailure: false,
    });
    expect(events.at(-1)).toEqual({ type: "response-complete" });
  });

  test("keeps disposer failure loud with its original cause", async () => {
    const disposeFailure = new Error("dispose failed");
    const definition = defineAgent({
      providers: [textModel()],
      model: "test/default",
      plugins: [
        definePlugin({
          name: "failing-dispose",
          tools: [],
          setup: async () => "resource",
          dispose: async () => {
            throw disposeFailure;
          },
        }),
      ],
    });
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* createSession(definition);
            yield* Stream.runDrain(session.prompt("Hi"));
          }),
        ),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const defect = Cause.findDefect(exit.cause);
      expect(Result.isSuccess(defect)).toBe(true);
      if (Result.isSuccess(defect)) expect(defect.success).toBe(disposeFailure);
    }
  });

  test("preserves the primary error when a disposer fails on a failed exit", async () => {
    const primary = new Error("primary");
    const log: Array<string> = [];
    const plugin = definePlugin({
      name: "failing-dispose",
      tools: [],
      setup: async () => "resource",
      dispose: async (resource) => {
        log.push(`dispose:${resource}`);
        throw new Error("dispose failed");
      },
    });

    await expect(
      withSession(
        defineAgent({ providers: [textModel()], model: "test/default", plugins: [plugin] }),
        async () => {
          throw primary;
        },
      ),
    ).rejects.toBe(primary);
    expect(log).toEqual(["dispose:resource"]);
  });
});
