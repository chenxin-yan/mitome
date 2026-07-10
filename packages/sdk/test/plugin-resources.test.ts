import { describe, expect, test } from "bun:test";
import { Cause, Context, Effect, Exit, Layer, Result, Stream } from "effect";
import { LanguageModel, Response, Toolkit } from "effect/unstable/ai";
import { createSession, makeModel, type Plugin } from "@mitome/core";
import {
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

const textModel = () =>
  makeModel(
    Layer.succeed(LanguageModel.LanguageModel, {
      streamText: () =>
        Stream.succeed(Response.makePart("text-delta", { id: "done", delta: "done" })),
    } as unknown as LanguageModel.Service),
  );

const toolModel = (name: string) => {
  let calls = 0;
  return makeModel(
    Layer.succeed(LanguageModel.LanguageModel, {
      streamText: (options: { readonly toolkit?: Toolkit.WithHandler<any> }) => {
        calls += 1;
        if (calls === 2)
          return Stream.succeed(Response.makePart("text-delta", { id: "done", delta: "done" }));
        const call = Response.makePart("tool-call", {
          id: "call-1",
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
      },
    } as unknown as LanguageModel.Service),
  );
};

describe("@mitome/sdk Plugin resources", () => {
  test("acquires resources before sessionStart in Definition order and disposes them in reverse", async () => {
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
        instructions: "Be concise.",
        model: textModel(),
        plugins: [plugin("first"), plugin("second"), plugin("third")],
      }),
      async (session) => {
        for await (const _event of session.prompt("Hi")) {
          // Complete one public Turn before the Session scope closes.
        }
      },
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
      setup: async () => {
        setupLog.push("setup:second");
        throw setupFailure;
      },
    });

    let setupError: unknown;
    try {
      await withSession(
        defineAgent({ instructions: "Be concise.", model: textModel(), plugins: [first, second] }),
        async () => undefined,
      );
    } catch (error) {
      setupError = error;
    }
    expect(setupError).toMatchObject({ _tag: "TurnError", cause: setupFailure });
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
    let hookError: unknown;
    try {
      await withSession(
        defineAgent({
          instructions: "Be concise.",
          model: textModel(),
          plugins: [plugin("first"), plugin("second", true)],
        }),
        async () => undefined,
      );
    } catch (error) {
      hookError = error;
    }
    expect(hookError).toMatchObject({ _tag: "TurnError", cause: hookFailure });
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
        instructions: "Be concise.",
        model: toolModel("alpha-tool"),
        plugins: [alpha, beta],
      }),
      async (session) => {
        const collected = [];
        for await (const event of session.prompt("Hi")) collected.push(event);
        return collected;
      },
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

  test("keeps a resource live across Turn cancellation and passes the Session AbortSignal", async () => {
    let calls = 0;
    let started!: () => void;
    let aborted!: () => void;
    const handlerStarted = new Promise<void>((resolve) => (started = resolve));
    const handlerAborted = new Promise<void>((resolve) => (aborted = resolve));
    const model = makeModel(
      Layer.succeed(LanguageModel.LanguageModel, {
        streamText: (options: { readonly toolkit?: Toolkit.WithHandler<any> }) => {
          calls += 1;
          if (calls === 3)
            return Stream.succeed(Response.makePart("text-delta", { id: "done", delta: "done" }));
          const call = Response.makePart("tool-call", {
            id: `call-${calls}`,
            name: "wait",
            params: "hello",
            providerExecuted: false,
          });
          return Stream.concat(
            Stream.succeed(call),
            Stream.unwrap(
              options.toolkit!.handle("wait", "hello").pipe(
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
      } as unknown as LanguageModel.Service),
    );
    let disposed = 0;
    const definition = defineAgent({
      instructions: "Be concise.",
      model,
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
              wait: (signal: {
                readonly aborted: boolean;
                addEventListener(...args: any[]): void;
              }) => {
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
      const next = [];
      for await (const event of session.prompt("second")) next.push(event);
      return next;
    });

    expect(calls).toBe(3);
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
      defineAgent({ instructions: "Be concise.", model: textModel(), plugins: [core, sdk] }),
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

  test("keeps disposer failure loud with its original cause", async () => {
    const disposeFailure = new Error("dispose failed");
    const definition = defineAgent({
      instructions: "Be concise.",
      model: textModel(),
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
});
