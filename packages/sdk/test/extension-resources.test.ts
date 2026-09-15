import { describe, expect, test } from "vitest";
import {
  Cause,
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Result,
  Schema,
  SchemaGetter,
  Stream,
} from "effect";
import { Response, Tool as AiTool, Toolkit } from "effect/unstable/ai";
import {
  createSession,
  defineExtension as defineCoreExtension,
  type Extension,
} from "@mitome/core";
import { jsonStringSchema, makeTestProvider, makeToolModel, stringSchema } from "./provider.js";
import { defineAgent, defineExtension, withSession } from "../src/index.js";

const textModel = () =>
  makeTestProvider(() =>
    Stream.succeed(Response.makePart("text-delta", { id: "done", delta: "done" })),
  );

describe("@mitome/sdk Extension resources", () => {
  test("acquires resources before sessionStart in Agent Definition order and releases them in reverse", async () => {
    const log: Array<string> = [];
    const extension = (name: string) =>
      defineExtension({
        name,
        resource: async ({ defer }) => {
          log.push(`acquire:${name}`);
          defer(() => void log.push(`release:${name}`));
          return name;
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
        extensions: [extension("first"), extension("second"), extension("third")],
      }),
      (session) => Array.fromAsync(session.runTurn("Hi")),
    );

    expect(log).toEqual([
      "acquire:first",
      "acquire:second",
      "acquire:third",
      "start:first",
      "start:second",
      "start:third",
      "release:third",
      "release:second",
      "release:first",
    ]);
  });

  test("runs deferred cleanups within one Extension in reverse registration order", async () => {
    const log: Array<string> = [];
    const extension = defineExtension({
      name: "lifo",
      resource: async ({ defer }) => {
        defer(() => void log.push("release:db"));
        defer(async () => void log.push("release:bus"));
        return "lifo";
      },
    });

    await withSession(
      defineAgent({ providers: [textModel()], model: "test/default", extensions: [extension] }),
      async () => undefined,
    );

    expect(log).toEqual(["release:bus", "release:db"]);
  });

  test("cleans acquired resources before acquisition and startup Hook failures escape", async () => {
    const acquireFailure = new Error("acquire failed");
    const hookFailure = new Error("hook failed");
    const acquireLog: Array<string> = [];
    const first = defineExtension({
      name: "first",
      resource: async ({ defer }) => {
        acquireLog.push("acquire:first");
        defer(() => void acquireLog.push("release:first"));
        return "first";
      },
    });
    const second = defineExtension({
      name: "second",
      resource: async (): Promise<string> => {
        acquireLog.push("acquire:second");
        throw acquireFailure;
      },
    });

    await expect(
      withSession(
        defineAgent({
          providers: [textModel()],
          model: "test/default",
          extensions: [first, second],
        }),
        async () => undefined,
      ),
    ).rejects.toMatchObject({ _tag: "TurnError", cause: acquireFailure });
    expect(acquireLog).toEqual(["acquire:first", "acquire:second", "release:first"]);

    const hookLog: Array<string> = [];
    const extension = (name: string, fail = false) =>
      defineExtension({
        name,
        resource: async ({ defer }) => {
          hookLog.push(`acquire:${name}`);
          defer(() => void hookLog.push(`release:${name}`));
          return name;
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
          extensions: [extension("first"), extension("second", true)],
        }),
        async () => undefined,
      ),
    ).rejects.toMatchObject({ _tag: "TurnError", cause: hookFailure });
    expect(hookLog).toEqual([
      "acquire:first",
      "acquire:second",
      "start:first",
      "start:second",
      "release:second",
      "release:first",
    ]);
  });

  test("runs cleanups deferred before a partial acquisition failure and releases earlier Extensions", async () => {
    const failure = new Error("bus failed");
    const log: Array<string> = [];
    const first = defineExtension({
      name: "first",
      resource: async ({ defer }) => {
        log.push("acquire:first");
        defer(() => void log.push("release:first"));
        return "first";
      },
    });
    const second = defineExtension({
      name: "second",
      resource: async ({ defer }): Promise<string> => {
        log.push("acquire:second:db");
        defer(() => void log.push("release:second:db"));
        log.push("acquire:second:bus");
        throw failure;
      },
    });

    await expect(
      withSession(
        defineAgent({
          providers: [textModel()],
          model: "test/default",
          extensions: [first, second],
        }),
        async () => undefined,
      ),
    ).rejects.toMatchObject({ _tag: "TurnError", cause: failure });
    expect(log).toEqual([
      "acquire:first",
      "acquire:second:db",
      "acquire:second:bus",
      "release:second:db",
      "release:first",
    ]);
  });

  test("keeps acquisition uninterruptible so cleanups deferred after an interrupt still run", async () => {
    const log: Array<string> = [];
    let openBus!: () => void;
    const busOpened = new Promise<void>((resolve) => {
      openBus = resolve;
    });
    const extension = defineExtension({
      name: "slow",
      resource: async ({ defer }) => {
        log.push("acquire:db");
        defer(() => void log.push("release:db"));
        await busOpened;
        log.push("acquire:bus");
        defer(() => void log.push("release:bus"));
        return "resource";
      },
    });
    const definition = defineAgent({
      providers: [textModel()],
      model: "test/default",
      extensions: [extension],
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.scoped(createSession(definition)));
        yield* Effect.yieldNow;
        expect(log).toEqual(["acquire:db"]);
        yield* Effect.forkChild(Fiber.interrupt(fiber));
        yield* Effect.yieldNow;
        openBus();
        yield* Fiber.await(fiber);
      }),
    );

    expect(log).toEqual(["acquire:db", "acquire:bus", "release:bus", "release:db"]);
  });

  test("provides each Extension only its own resource to Hooks and Tool handlers", async () => {
    const log: Array<string> = [];
    const alpha = defineExtension({
      name: "alpha",
      tools: ({ tool }) => [
        tool({
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
      resource: async () => ({ name: "alpha", count: 1 }),
    });
    const beta = defineExtension({
      name: "beta",
      resource: async () => ({ name: "beta", enabled: true }),
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
        extensions: [alpha, beta],
      }),
      (session) => Array.fromAsync(session.runTurn("Hi")),
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

  test("provides the resource to every Hook and releases after sessionEnd", async () => {
    const log: Array<string> = [];
    const extension = defineExtension({
      name: "all-hooks",
      resource: async ({ defer }) => {
        log.push("acquire");
        defer(() => void log.push("release:res"));
        return "res";
      },
      tools: ({ tool }) => [
        tool({
          name: "res-tool",
          inputSchema: jsonStringSchema,
          outputSchema: stringSchema,
          handler: async (input, { resource }) => {
            log.push(`tool:${resource}`);
            return input;
          },
        }),
      ],
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
        extensions: [extension],
      }),
      (session) => Array.fromAsync(session.runTurn("Hi")),
    );

    expect(log).toEqual([
      "acquire",
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
      "release:res",
    ]);
  });

  test("does not expose one core Extension's resource to another", async () => {
    const Owned = Context.Service<string>("test/Owned");
    const Intruding = Context.Service<string>("test/Intruding");
    const owner: Extension<string> = {
      name: "owner",
      resource: Layer.succeed(Owned, "owned"),
    };
    // Both tags share the identifier type, so this compiles as Extension<string>;
    // only runtime per-extension context isolation can reject the foreign lookup.
    const intruder: Extension<string> = {
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
              extensions: [owner, intruder],
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
    let released = 0;
    const definition = defineAgent({
      providers: [model],
      model: "test/default",
      extensions: [
        defineExtension({
          name: "wait",
          resource: async ({ defer }) => {
            defer(() => void (released += 1));
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
          tools: ({ tool }) => [
            tool({
              name: "wait",
              inputSchema: jsonStringSchema,
              outputSchema: stringSchema,
              handler: async (_input, { resource, signal }) => resource.wait(signal),
            }),
          ],
        }),
      ],
    });

    const events = await withSession(definition, async (session) => {
      const iterator = session.runTurn("first")[Symbol.asyncIterator]();
      await iterator.next();
      const pending = iterator.next();
      await handlerStarted;
      await iterator.return?.();
      await handlerAborted;
      await pending.catch(() => undefined);
      return Array.fromAsync(session.runTurn("second"));
    });

    expect(events.at(-1)).toEqual({ type: "response-complete" });
    expect(released).toBe(1);
  });

  test("mixes an Effect-native resource Extension with an SDK resource Extension", async () => {
    const log: Array<string> = [];
    const CoreResource = Context.Service<string>("test/CoreResource");
    const core: Extension<string> = {
      name: "core",
      resource: Layer.effect(
        CoreResource,
        Effect.acquireRelease(
          Effect.sync(() => {
            log.push("acquire:core");
            return "core";
          }),
          (resource) => Effect.sync(() => void log.push(`release:${resource}`)),
        ),
      ),
      hooks: {
        sessionStart: Effect.service(CoreResource).pipe(
          Effect.tap((resource) => Effect.sync(() => void log.push(`start:${resource}`))),
          Effect.asVoid,
        ),
      },
    };
    const sdk = defineExtension({
      name: "sdk",
      resource: async ({ defer }) => {
        log.push("acquire:sdk");
        defer(() => void log.push("release:sdk"));
        return "sdk";
      },
      hooks: { sessionStart: async ({ resource }) => void log.push(`start:${resource}`) },
    });

    await withSession(
      defineAgent({ providers: [textModel()], model: "test/default", extensions: [core, sdk] }),
      async () => undefined,
    );
    expect(log).toEqual([
      "acquire:core",
      "acquire:sdk",
      "start:core",
      "start:sdk",
      "release:sdk",
      "release:core",
    ]);
  });

  test("provides the owning Extension's resource to native Tool schema encoding", async () => {
    const Prefix = Context.Service<string>("test/Prefix");
    // Success schema whose encoding requires the Prefix service from the Extension resource.
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
    const native = defineCoreExtension({
      name: "native",
      resource: Layer.succeed(Prefix, "pre"),
      toolkit: Toolkit.make(echo),
      handlers: { "native-echo": () => Effect.succeed("hello") },
      // postTool forces the validateResult re-encoding path as well.
      hooks: { postTool: (context) => Effect.succeed(context.result) },
    });
    const model = makeToolModel("native-echo", 2, { text: "hi" }).provider;

    const events = await withSession(
      defineAgent({ providers: [model], model: "test/default", extensions: [native] }),
      (session) => Array.fromAsync(session.runTurn("Hi")),
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

  test("keeps cleanup failure loud with its original cause and still runs earlier cleanups", async () => {
    const cleanupFailure = new Error("cleanup failed");
    const log: Array<string> = [];
    const definition = defineAgent({
      providers: [textModel()],
      model: "test/default",
      extensions: [
        defineExtension({
          name: "failing-cleanup",
          resource: async ({ defer }) => {
            defer(() => void log.push("release:db"));
            defer(async () => {
              throw cleanupFailure;
            });
            return "resource";
          },
        }),
      ],
    });
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* createSession(definition);
            yield* Stream.runDrain(session.runTurn("Hi"));
          }),
        ),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const defect = Cause.findDefect(exit.cause);
      expect(Result.isSuccess(defect)).toBe(true);
      if (Result.isSuccess(defect)) expect(defect.success).toBe(cleanupFailure);
    }
    expect(log).toEqual(["release:db"]);
  });

  test("preserves the primary error when a cleanup fails on a failed exit", async () => {
    const primary = new Error("primary");
    const log: Array<string> = [];
    const extension = defineExtension({
      name: "failing-cleanup",
      resource: async ({ defer }) => {
        defer(() => {
          log.push("release:resource");
          throw new Error("cleanup failed");
        });
        return "resource";
      },
    });

    await expect(
      withSession(
        defineAgent({ providers: [textModel()], model: "test/default", extensions: [extension] }),
        async () => {
          throw primary;
        },
      ),
    ).rejects.toBe(primary);
    expect(log).toEqual(["release:resource"]);
  });
});
