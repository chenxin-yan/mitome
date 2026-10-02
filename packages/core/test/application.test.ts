import { describe, expect, it } from "@effect/vitest";
import { Context, Deferred, Effect, Exit, Fiber, Layer, Logger, Schema, Scope } from "effect";
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai";
import {
  ApplicationClosedError,
  defineMitome,
  firstPartyExecutionLimits,
  localTools,
  loop,
  makeProvider,
  ModelSelectionError,
  SessionReleasedError,
  Turn,
  type LocalTools,
} from "../src/index.js";
import { call, finish, type Script, scriptedModel, text } from "./support/step.js";

const Lookup = Tool.make("lookup", {
  parameters: Schema.Struct({ key: Schema.String }),
  success: Schema.String,
});
const Kit = Toolkit.make(Lookup);

/** Shared infrastructure: a store and the native Tools registered once against it. */
class Store extends Context.Service<Store, { readonly read: (key: string) => string }>()(
  "test/Store",
) {}
class Tools extends Context.Service<Tools, LocalTools<Toolkit.Tools<typeof Kit>>>()("test/Tools") {}

const infrastructure = (log: Array<string>) => {
  const store = Layer.effect(
    Store,
    Effect.acquireRelease(
      Effect.sync(() => (log.push("store:acquire"), { read: (key: string) => `value of ${key}` })),
      () => Effect.sync(() => void log.push("store:release")),
    ),
  );
  const tools = Layer.effect(
    Tools,
    localTools(
      Kit,
      Effect.gen(function* () {
        const { read } = yield* Store;
        log.push("tools:register");
        return Kit.of({ lookup: ({ key }) => Effect.sync(() => read(key)) });
      }),
    ),
  );
  return Layer.provideMerge(tools, store);
};

const user = (value: string) =>
  Effect.gen(function* () {
    const turn = yield* Turn;
    yield* turn.stage(Prompt.userMessage({ content: [Prompt.textPart({ text: value })] }));
  });

/** The ordinary program: one whole-function Turn running the default loop with shared Tools. */
const agent = (message: string) =>
  Effect.gen(function* () {
    yield* user(message);
    const result = yield* loop({ tools: yield* Tools });
    return result.response.text;
  });

/** A scripted Provider whose provisioning is observable; `fail` lists Model ids that fail. */
const scripted = (
  script: Script,
  log: Array<string>,
  fail: ReadonlySet<string> = new Set(),
  id: "scripted" | "spare" = "scripted",
) =>
  makeProvider(
    id,
    ["fixed"] as const,
    "SCRIPTED_KEY",
    (modelId) =>
      Layer.unwrap(
        Effect.gen(function* () {
          log.push(`provision:${id}/${modelId}`);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => void log.push(`release:${id}/${modelId}`)),
          );
          if (fail.has(modelId)) return yield* Effect.fail(`${modelId} unavailable`);
          return scriptedModel(script, log);
        }),
      ),
    { fixed: { contextWindow: 1000 } },
  );

/** Lets forked fibers run up to their next asynchronous wait. */
const settle = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, { discard: true });

const roles = (history: ReadonlyArray<Prompt.Message>) => history.map((message) => message.role);

describe("defineMitome application", () => {
  it.effect("acquires infrastructure once and serves explicit fresh Sessions", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const app = defineMitome({
        program: agent,
        limits: firstPartyExecutionLimits,
        infrastructure: infrastructure(log),
        providers: [
          scripted(
            [
              [call("c1", "lookup", "alpha"), finish("tool-calls")],
              [text("found alpha"), finish("stop")],
              [text("hello again"), finish("stop")],
            ],
            log,
          ),
        ],
        defaultModel: "scripted/fixed",
      });
      expect(log).toEqual([]);

      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const application = yield* app.acquire();
          const first = yield* application.session;
          const second = yield* application.session;
          const one = yield* first.run("look up alpha");
          const two = yield* second.run("hi");
          return {
            one,
            two,
            first: roles(yield* first.history),
            second: roles(yield* second.history),
            before: [...log],
          };
        }),
      );
      expect(result.one).toBe("found alpha");
      expect(result.two).toBe("hello again");
      // Each Session keeps only its own committed conversation, including actual Tool work.
      expect(result.first).toEqual(["user", "assistant", "tool", "assistant"]);
      expect(result.second).toEqual(["user", "assistant"]);
      expect(result.before).toEqual([
        "store:acquire",
        "tools:register",
        "provision:scripted/fixed",
        "generate:1",
        "generate:3",
        "generate:1",
      ]);
      // Shutdown releases the Model binding before the infrastructure it was built after.
      expect(log.slice(result.before.length)).toEqual(["release:scripted/fixed", "store:release"]);
    }),
  );

  it.effect("binds each Turn's own Scope rather than the acquisition Scope", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const scopes: Array<Scope.Scope> = [];
      const app = defineMitome({
        program: (label: string) =>
          Effect.gen(function* () {
            scopes.push(yield* Scope.Scope);
            yield* Store;
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => void log.push(`finalized:${label}`)),
            );
            return label;
          }),
        limits: firstPartyExecutionLimits,
        infrastructure: infrastructure(log),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const application = yield* app.acquire();
          const session = yield* application.session;
          yield* session.run("one");
          // The callback's resource closed with its Turn, not with the application.
          expect(log).toEqual(["store:acquire", "tools:register", "finalized:one"]);
          yield* session.run("two");
          expect(log.at(-1)).toBe("finalized:two");
        }),
      );
      expect(scopes).toHaveLength(2);
      expect(scopes[0]).not.toBe(scopes[1]);
      expect(log.at(-1)).toBe("store:release");
    }),
  );

  it.effect("retains idle Sessions until explicit close or shutdown, and then admits nothing", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const app = defineMitome({
        program: (label: string) => Effect.as(user(label), label),
        limits: firstPartyExecutionLimits,
        infrastructure: infrastructure(log),
      });
      const scope = yield* Scope.make();
      const application = yield* app.acquire().pipe(Scope.provide(scope));
      const kept = yield* application.session;
      const closed = yield* application.session;
      yield* kept.run("kept");
      // Detaching the last observer neither closes nor releases the Session.
      yield* Effect.scoped(kept.observe(1));
      expect(roles(yield* kept.history)).toEqual(["user"]);

      yield* closed.close;
      expect(yield* Effect.flip(closed.history)).toBeInstanceOf(SessionReleasedError);
      expect(yield* Effect.flip(closed.run("late"))).toBeInstanceOf(SessionReleasedError);
      expect(log).not.toContain("store:release");
      expect(yield* kept.run("again")).toBe("again");

      yield* Scope.close(scope, Exit.void);
      expect(log.at(-1)).toBe("store:release");
      expect(yield* Effect.flip(kept.history)).toBeInstanceOf(SessionReleasedError);
      expect(yield* Effect.flip(kept.run("late"))).toBeInstanceOf(ApplicationClosedError);
      expect(yield* Effect.flip(application.session)).toBeInstanceOf(ApplicationClosedError);
      expect(yield* Effect.flip(application.provide(Effect.void))).toBeInstanceOf(
        ApplicationClosedError,
      );
    }),
  );

  it.effect("closes admission, cancels all owned work, then drains it before releasing", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const app = defineMitome({
        program: (label: string) =>
          Effect.gen(function* () {
            const store = yield* Store;
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                log.push(`cleanup-start:${label}`);
                yield* Deferred.await(release);
                log.push(`cleanup:${label}:${store.read("k")}`);
              }),
            );
            if (label === "newer") yield* Deferred.succeed(started, undefined);
            return yield* Effect.never;
          }),
        limits: firstPartyExecutionLimits,
        infrastructure: infrastructure(log),
      });
      const scope = yield* Scope.make();
      const application = yield* app.acquire().pipe(Scope.provide(scope));
      const older = yield* application.session;
      const newer = yield* application.session;
      const idle = yield* application.session;
      const running = yield* Effect.forkChild(older.run("older"));
      yield* settle;
      yield* Effect.forkChild(newer.run("newer"));
      yield* Deferred.await(started);

      const first = yield* Effect.forkChild(application.shutdown);
      const second = yield* Effect.forkChild(application.shutdown);
      yield* settle;
      expect(yield* Effect.flip(application.session)).toBeInstanceOf(ApplicationClosedError);
      expect(yield* Effect.flip(idle.run("late"))).toBeInstanceOf(ApplicationClosedError);
      // Both Turns were cancelled although each one's cleanup is held, so neither shutdown call
      // has finished and nothing they use was released.
      expect(log.filter((entry) => entry.startsWith("cleanup-start:")).sort()).toEqual([
        "cleanup-start:newer",
        "cleanup-start:older",
      ]);
      expect(first.pollUnsafe()).toBeUndefined();
      expect(second.pollUnsafe()).toBeUndefined();
      expect(log).not.toContain("store:release");

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(log.slice(-3).sort()).toEqual([
        "cleanup:newer:value of k",
        "cleanup:older:value of k",
        "store:release",
      ]);
      expect(log.at(-1)).toBe("store:release");
      expect(Exit.hasInterrupts(yield* Fiber.await(running))).toBe(true);
      // Closing the owning Scope afterwards is the same, already finished, shutdown.
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("keeps infrastructure live while an explicit Session close is still draining", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const app = defineMitome({
        program: () =>
          Effect.gen(function* () {
            const store = yield* Store;
            yield* Effect.addFinalizer(() =>
              Effect.andThen(
                Deferred.await(release),
                Effect.sync(() => void log.push(`cleanup:${store.read("k")}`)),
              ),
            );
            yield* Deferred.succeed(started, undefined);
            return yield* Effect.never;
          }),
        limits: firstPartyExecutionLimits,
        infrastructure: infrastructure(log),
      });
      const scope = yield* Scope.make();
      const application = yield* app.acquire().pipe(Scope.provide(scope));
      const session = yield* application.session;
      yield* Effect.forkChild(session.run(undefined));
      yield* Deferred.await(started);

      const closing = yield* Effect.forkChild(session.close);
      yield* settle;
      const again = yield* Effect.forkChild(session.close);
      const shutdown = yield* Effect.forkChild(application.shutdown);
      yield* settle;
      expect(closing.pollUnsafe()).toBeUndefined();
      expect(again.pollUnsafe()).toBeUndefined();
      expect(shutdown.pollUnsafe()).toBeUndefined();
      expect(log).not.toContain("store:release");

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(closing);
      yield* Fiber.join(again);
      yield* Fiber.join(shutdown);
      expect(log.slice(-2)).toEqual(["cleanup:value of k", "store:release"]);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("unwinds a startup that fails after partial acquisition", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const app = defineMitome({
        program: () => Effect.void,
        limits: firstPartyExecutionLimits,
        infrastructure: infrastructure(log),
        providers: [scripted([], log, new Set(["broken"]))],
      });
      const failure = yield* Effect.flip(
        Effect.scoped(Effect.andThen(app.acquire({ model: "scripted/broken" }), Effect.never)),
      );
      expect(failure).toBe("broken unavailable");
      expect(log).toEqual([
        "store:acquire",
        "tools:register",
        "provision:scripted/broken",
        "release:scripted/broken",
        "store:release",
      ]);

      // The embedding hears that shutdown began before the failed startup unwinds.
      log.length = 0;
      yield* Effect.flip(
        Effect.scoped(
          app.acquire({
            model: "scripted/broken",
            onShutdown: Effect.sync(() => void log.push("shutdown:begin")),
          }),
        ),
      );
      expect(log).toEqual([
        "store:acquire",
        "tools:register",
        "provision:scripted/broken",
        "release:scripted/broken",
        "shutdown:begin",
        "store:release",
      ]);
    }),
  );

  it.effect("closes infrastructure with the failure of a failed startup", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const exitAware = Layer.effectDiscard(
        Effect.acquireRelease(Effect.void, (_, exit) =>
          Effect.sync(() => void log.push(`infra:${exit._tag}`)),
        ),
      );
      const app = defineMitome({
        program: () => Effect.void,
        limits: firstPartyExecutionLimits,
        infrastructure: Layer.merge(infrastructure(log), exitAware),
        providers: [scripted([], log, new Set(["broken"]))],
      });
      yield* Effect.flip(Effect.scoped(app.acquire({ model: "scripted/broken" })));
      expect(log).toContain("infra:Failure");

      log.length = 0;
      yield* Effect.scoped(app.acquire({ model: "scripted/fine" }));
      expect(log).toContain("infra:Success");
    }),
  );

  it.effect("still releases everything when the shutdown notification fails", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const app = defineMitome({
        program: () => Effect.void,
        limits: firstPartyExecutionLimits,
        infrastructure: infrastructure(log),
        providers: [scripted([], log)],
      });
      const exit = yield* Effect.exit(
        Effect.scoped(
          app.acquire({ model: "scripted/m", onShutdown: Effect.die("notification failed") }),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(log).toEqual([
        "store:acquire",
        "tools:register",
        "provision:scripted/m",
        "release:scripted/m",
        "store:release",
      ]);
    }),
  );

  it.effect("is ready only after Host startup, and unwinds a Host that fails to start", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const gate = yield* Deferred.make<void>();
      const host = (name: string, fail: boolean) => ({
        name,
        start: () =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() => Effect.sync(() => void log.push(`${name}:release`)));
            yield* Deferred.await(gate);
            log.push(`${name}:started`);
            if (fail) return yield* Effect.fail(`${name} failed to start`);
            return Effect.never;
          }),
      });
      const healthy = defineMitome({
        program: () => Effect.void,
        limits: firstPartyExecutionLimits,
        infrastructure: infrastructure(log),
        hosts: [host("a", false)],
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const acquiring = yield* Effect.forkChild(healthy.acquire({ serve: true }));
          yield* settle;
          expect(acquiring.pollUnsafe()).toBeUndefined();
          yield* Deferred.succeed(gate, undefined);
          yield* Fiber.join(acquiring);
          expect(log).toContain("a:started");
        }),
      );

      log.length = 0;
      const failing = defineMitome({
        program: () => Effect.void,
        limits: firstPartyExecutionLimits,
        infrastructure: infrastructure(log),
        hosts: [host("a", false), host("b", true)],
      });
      const failure = yield* Effect.flip(Effect.scoped(failing.acquire({ serve: true })));
      expect(failure).toBe("b failed to start");
      expect(log).toEqual([
        "store:acquire",
        "tools:register",
        "a:started",
        "b:started",
        "b:release",
        "a:release",
        "store:release",
      ]);
    }),
  );

  it.effect("reports one serving Host failure without restarting it or stopping the other", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const errors: Array<string> = [];
      const fail = yield* Deferred.make<void>();
      const reported = yield* Deferred.make<void>();
      const logger = Logger.make(({ logLevel, message }) => {
        if (logLevel !== "Error") return;
        errors.push(String(Array.isArray(message) ? message[0] : message));
        Deferred.doneUnsafe(reported, Exit.void);
      });
      const app = defineMitome({
        program: (label: string) => Effect.succeed(label),
        limits: firstPartyExecutionLimits,
        infrastructure: infrastructure(log),
        hosts: [
          {
            name: "flaky",
            start: () =>
              Effect.sync(() => {
                log.push("flaky:start");
                return Effect.andThen(Deferred.await(fail), Effect.fail("lost connection"));
              }),
          },
          {
            name: "steady",
            start: () =>
              Effect.sync(() => {
                log.push("steady:start");
                return Effect.never.pipe(
                  Effect.onInterrupt(() => Effect.sync(() => void log.push("steady:stopped"))),
                );
              }),
          },
        ],
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const application = yield* app.acquire({ serve: true });
          const session = yield* application.session;
          yield* Deferred.succeed(fail, undefined);
          yield* Deferred.await(reported);
          yield* settle;
          expect(errors).toEqual(['Serving Host "flaky" failed']);
          expect(log.filter((entry) => entry.endsWith(":start"))).toEqual([
            "flaky:start",
            "steady:start",
          ]);
          expect(log).not.toContain("steady:stopped");
          expect(yield* session.run("still serving")).toBe("still serving");
        }),
      ).pipe(Effect.provide(Logger.layer([logger])));
      expect(log.slice(-2)).toEqual(["steady:stopped", "store:release"]);
    }),
  );
});

describe("defineMitome Model selection", () => {
  const selecting = (log: Array<string>, fail: ReadonlySet<string> = new Set()) =>
    defineMitome({
      program: () => Effect.void,
      limits: firstPartyExecutionLimits,
      infrastructure: infrastructure(log),
      providers: [scripted([], log, fail), scripted([], log, fail, "spare")],
      defaultModel: "scripted/fixed",
      fallbackModels: ["spare/first", "scripted/second"],
    });
  const acquired = (
    app: ReturnType<typeof selecting>,
    options: Parameters<typeof app.acquire>[0],
  ) => Effect.scoped(Effect.asVoid(app.acquire(options)));

  it.effect("rejects malformed and unknown selections before acquiring anything", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const app = selecting(log);
      for (const options of [
        { model: "no-separator" },
        { model: "/fixed" },
        { model: "missing/fixed" },
        { provider: "missing" },
        { provider: "spare", model: "scripted/fixed" },
      ]) {
        expect(yield* Effect.flip(acquired(app, options))).toBeInstanceOf(ModelSelectionError);
      }
      expect(log).toEqual([]);
    }),
  );

  it.effect("provisions an explicit unlisted Model id as-is and never falls back from it", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const app = selecting(log, new Set(["broken"]));
      yield* acquired(app, { model: "scripted/private/fine-tune" });
      expect(log).toContain("provision:scripted/private/fine-tune");

      log.length = 0;
      expect(yield* Effect.flip(acquired(app, { model: "scripted/broken" }))).toBe(
        "broken unavailable",
      );
      expect(log.filter((entry) => entry.startsWith("provision:"))).toEqual([
        "provision:scripted/broken",
      ]);
    }),
  );

  it.effect("falls back in configured order, releasing each failed attempt first", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      yield* acquired(selecting(log, new Set(["fixed", "first"])), {});
      expect(log.filter((entry) => /^(provision|release):/.test(entry))).toEqual([
        "provision:scripted/fixed",
        "release:scripted/fixed",
        "provision:spare/first",
        "release:spare/first",
        "provision:scripted/second",
        "release:scripted/second",
      ]);

      log.length = 0;
      yield* acquired(selecting(log, new Set(["fixed"])), { provider: "scripted" });
      expect(log.filter((entry) => entry.startsWith("provision:"))).toEqual([
        "provision:scripted/fixed",
        "provision:scripted/second",
      ]);

      log.length = 0;
      const exhausted = yield* Effect.flip(
        acquired(selecting(log, new Set(["fixed", "first", "second"])), {}),
      );
      if (!(exhausted instanceof ModelSelectionError))
        throw new Error("expected a selection error");
      expect(exhausted.message).toContain(
        "scripted/fixed: fixed unavailable; spare/first: first unavailable; scripted/second: second unavailable",
      );
      expect(log.at(-1)).toBe("store:release");
    }),
  );

  it.effect("does not treat a provisioning defect as fallback", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const defective = makeProvider("defective", [], undefined, () =>
        Layer.effect(LanguageModel.LanguageModel, Effect.die(new Error("provision bug"))),
      );
      const app = defineMitome({
        program: () => Effect.void,
        limits: firstPartyExecutionLimits,
        infrastructure: infrastructure(log),
        providers: [defective, scripted([], log)],
        defaultModel: "defective/any",
        fallbackModels: ["scripted/fixed"],
      });
      const exit = yield* Effect.exit(Effect.scoped(app.acquire()));
      expect(Exit.hasDies(exit)).toBe(true);
      expect(log).not.toContain("provision:scripted/fixed");
      expect(log.at(-1)).toBe("store:release");
    }),
  );

  it.effect("requires a selectable Model when Providers are declared", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const app = defineMitome({
        program: () => Effect.void,
        limits: firstPartyExecutionLimits,
        providers: [scripted([], log)],
      });
      expect(yield* Effect.flip(Effect.scoped(app.acquire()))).toBeInstanceOf(ModelSelectionError);
      expect(log).toEqual([]);
    }),
  );

  it("discovers Providers without provisioning and rejects ambiguous compositions", () => {
    const log: Array<string> = [];
    const app = selecting(log);
    expect(app.discovery).toEqual([
      {
        id: "scripted",
        modelIds: ["fixed"],
        models: { fixed: { contextWindow: 1000 } },
        credential: "SCRIPTED_KEY",
      },
      {
        id: "spare",
        modelIds: ["fixed"],
        models: { fixed: { contextWindow: 1000 } },
        credential: "SCRIPTED_KEY",
      },
    ]);
    expect(log).toEqual([]);
    expect(() =>
      defineMitome({
        program: () => Effect.void,
        limits: firstPartyExecutionLimits,
        providers: [scripted([], log), scripted([], log)],
      }),
    ).toThrow('Duplicate Provider id "scripted"');
    expect(() =>
      defineMitome({
        program: () => Effect.void,
        limits: firstPartyExecutionLimits,
        providers: [scripted([], log)],
        // SAFETY: deliberately mistyped, so the runtime check sees an id the types would reject.
        defaultModel: "scriptedfixed" as "scripted/fixed",
      }),
    ).toThrow("names no declared Provider");
  });
});
