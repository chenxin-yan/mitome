import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Schema,
  Scheduler,
  Scope,
} from "effect";
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai";
import {
  Agent,
  Approver,
  Command,
  Extension,
  Mitome,
  MitomeClosedError,
  ModelSelectionError,
  Provider,
  SessionReleasedError,
  TextMappingError,
  Turn,
} from "../../src/index.js";
import { localTools, loop, type LocalTools } from "../../src/kernel.js";
import { call, finish, type Script, scriptedModel, text } from "../support/step.js";

const Lookup = Tool.make("lookup", {
  parameters: Schema.Struct({ key: Schema.String }),
  success: Schema.String,
});
const Kit = Toolkit.make(Lookup);

/** Shared services: a store and the native Tools registered once against it. */
class Store extends Context.Service<Store, { readonly read: (key: string) => string }>()(
  "test/Store",
) {}
class Tools extends Context.Service<Tools, LocalTools<Toolkit.Tools<typeof Kit>>>()("test/Tools") {}

const layer = (log: Array<string>) => {
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
const answer = (message: string) =>
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
  Provider.make(id, {
    modelIds: ["fixed"] as const,
    credential: "SCRIPTED_KEY",
    provision: (modelId) =>
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
    models: { fixed: { contextWindow: 1000 } },
  });

const roles = (history: ReadonlyArray<Prompt.Message>) => history.map((message) => message.role);

describe("Mitome.make Configuration", () => {
  it.effect("acquires the layer once and serves explicit fresh Sessions", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const app = Mitome.make({
        agent: Agent.make({
          program: answer,
        }),
        provide: layer(log),
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
        model: "scripted/fixed",
      });
      expect(log).toEqual([]);

      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const instance = yield* app.acquire();
          const first = yield* instance.session();
          const second = yield* instance.session();
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
      // Shutdown releases the Model binding before the layer it was built after.
      expect(log.slice(result.before.length)).toEqual(["release:scripted/fixed", "store:release"]);
    }),
  );

  it.effect("builds the layer in the caller's span, adding none of its own", () =>
    Effect.gen(function* () {
      const spans: Array<string> = [];
      const app = Mitome.make({
        agent: Agent.make({ program: () => Effect.succeed("") }),
        provide: Layer.effectDiscard(
          Effect.map(Effect.currentSpan, (span) => void spans.push(span.name)),
        ),
      });
      yield* Effect.scoped(app.acquire()).pipe(Effect.withSpan("caller"));
      expect(spans).toEqual(["caller"]);
    }),
  );

  it.effect("binds each Turn's own Scope rather than the acquisition Scope", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const scopes: Array<Scope.Scope> = [];
      const app = Mitome.make({
        agent: Agent.make({
          program: (label: string) =>
            Effect.gen(function* () {
              scopes.push(yield* Scope.Scope);
              yield* Store;
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => void log.push(`finalized:${label}`)),
              );
              return label;
            }),
        }),
        provide: layer(log),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const instance = yield* app.acquire();
          const session = yield* instance.session();
          yield* session.run("one");
          // The callback's resource closed with its Turn, not with the instance.
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
      const app = Mitome.make({
        agent: Agent.make({
          program: (label: string) => Effect.as(user(label), label),
        }),
        provide: layer(log),
      });
      const scope = yield* Scope.make();
      const instance = yield* app.acquire().pipe(Scope.provide(scope));
      const kept = yield* instance.session();
      const closed = yield* instance.session();
      yield* kept.run("kept");
      expect(roles(yield* kept.history)).toEqual(["user"]);

      yield* closed.close;
      expect(yield* Effect.flip(closed.history)).toBeInstanceOf(SessionReleasedError);
      expect(yield* Effect.flip(closed.run("late"))).toBeInstanceOf(SessionReleasedError);
      expect(log).not.toContain("store:release");
      expect(yield* kept.run("again")).toBe("again");

      yield* Scope.close(scope, Exit.void);
      expect(log.at(-1)).toBe("store:release");
      expect(yield* Effect.flip(kept.history)).toBeInstanceOf(SessionReleasedError);
      expect(yield* Effect.flip(kept.run("late"))).toBeInstanceOf(MitomeClosedError);
      expect(yield* Effect.flip(instance.session())).toBeInstanceOf(MitomeClosedError);
      expect(yield* Effect.flip(instance.provide(Effect.void))).toBeInstanceOf(MitomeClosedError);
    }),
  );

  it.effect("closes admission, cancels all owned work, then drains it before releasing", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const started = { older: yield* Deferred.make<void>(), newer: yield* Deferred.make<void>() };
      const cleaning = { older: yield* Deferred.make<void>(), newer: yield* Deferred.make<void>() };
      const release = yield* Deferred.make<void>();
      const app = Mitome.make({
        agent: Agent.make({
          program: (label: string) =>
            Effect.gen(function* () {
              const store = yield* Store;
              const signal = label === "newer" ? "newer" : "older";
              yield* Effect.addFinalizer(() =>
                Effect.gen(function* () {
                  log.push(`cleanup-start:${label}`);
                  yield* Deferred.succeed(cleaning[signal], undefined);
                  yield* Deferred.await(release);
                  log.push(`cleanup:${label}:${store.read("k")}`);
                }),
              );
              yield* Deferred.succeed(started[signal], undefined);
              return yield* Effect.never;
            }),
        }),
        provide: layer(log),
      });
      const scope = yield* Scope.make();
      const instance = yield* app.acquire().pipe(Scope.provide(scope));
      const older = yield* instance.session();
      const newer = yield* instance.session();
      const idle = yield* instance.session();
      const running = yield* Effect.forkChild(older.run("older"));
      yield* Deferred.await(started.older);
      yield* Effect.forkChild(newer.run("newer"));
      yield* Deferred.await(started.newer);

      const first = yield* Effect.forkChild(instance.shutdown);
      const second = yield* Effect.forkChild(instance.shutdown);
      yield* Deferred.await(cleaning.older);
      yield* Deferred.await(cleaning.newer);
      expect(yield* Effect.flip(instance.session())).toBeInstanceOf(MitomeClosedError);
      expect(yield* Effect.flip(idle.run("late"))).toBeInstanceOf(MitomeClosedError);
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

  it.effect("keeps the layer live while an explicit Session close is still draining", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const cleaning = yield* Deferred.make<void>();
      const app = Mitome.make({
        agent: Agent.make({
          program: () =>
            Effect.gen(function* () {
              const store = yield* Store;
              yield* Effect.addFinalizer(() =>
                Effect.andThen(
                  Effect.andThen(Deferred.succeed(cleaning, undefined), Deferred.await(release)),
                  Effect.sync(() => void log.push(`cleanup:${store.read("k")}`)),
                ),
              );
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            }),
        }),
        provide: layer(log),
      });
      const scope = yield* Scope.make();
      const notified = yield* Deferred.make<void>();
      const instance = yield* app
        .acquire({ onShutdown: Deferred.succeed(notified, undefined) })
        .pipe(Scope.provide(scope));
      const session = yield* instance.session();
      yield* Effect.forkChild(session.run(""));
      yield* Deferred.await(started);

      const closing = yield* Effect.forkChild(session.close);
      yield* Deferred.await(cleaning);
      const again = yield* Effect.forkChild(session.close);
      const shutdown = yield* Effect.forkChild(instance.shutdown);
      yield* Deferred.await(notified);
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

  it.effect("finishes a shutdown whose first caller was interrupted, once, for later callers", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const notifying = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const app = Mitome.make({
        agent: Agent.make({ program: () => Effect.succeed("") }),
        provide: layer(log),
      });
      const scope = yield* Scope.make();
      const instance = yield* app
        .acquire({
          onShutdown: Effect.gen(function* () {
            log.push("shutdown:begin");
            yield* Deferred.succeed(notifying, undefined);
            yield* Deferred.await(resume);
            log.push("shutdown:end");
          }),
        })
        .pipe(Scope.provide(scope));

      const first = yield* Effect.forkChild(instance.shutdown);
      yield* Deferred.await(notifying);
      yield* Fiber.interrupt(first);
      const second = yield* Effect.forkChild(instance.shutdown);
      expect(second.pollUnsafe()).toBeUndefined();
      expect(log).not.toContain("store:release");

      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(second);
      yield* Scope.close(scope, Exit.void);
      expect(log).toEqual([
        "store:acquire",
        "tools:register",
        "shutdown:begin",
        "shutdown:end",
        "store:release",
      ]);
    }),
  );

  it.effect(
    "keeps a shutdown that its first caller left while launching it, for later callers",
    () =>
      Effect.gen(function* () {
        const log: Array<string> = [];
        const resume = yield* Deferred.make<void>();
        const app = Mitome.make({
          agent: Agent.make({
            program: () => Effect.succeed(""),
          }),
          provide: layer(log),
        });
        const scope = yield* Scope.make();
        const instance = yield* app
          .acquire({
            onShutdown: Effect.andThen(
              Effect.sync(() => void log.push("shutdown:begin")),
              Deferred.await(resume),
            ),
          })
          .pipe(Scope.provide(scope));

        // A scheduler that yields every fiber but the first caller at its second instruction, and
        // holds the queued tasks for the test: the launching fiber then stops right after it forks
        // the shared work and before it publishes that work's handle.
        const tasks: Array<() => void> = [];
        let caller: Fiber.Fiber<unknown, unknown> | undefined;
        const scheduler: Scheduler.Scheduler = {
          executionMode: "async",
          shouldYield: (fiber) => fiber !== (caller ??= fiber) && fiber.currentOpCount >= 2,
          makeDispatcher: () => ({
            scheduleTask: (task) => void tasks.push(task),
            flush: () => {},
          }),
        };
        const first = yield* Effect.forkChild(
          instance.shutdown.pipe(Effect.provideService(Scheduler.Scheduler, scheduler)),
          { startImmediately: true },
        );
        tasks.shift()?.();
        // The first caller leaves in that gap.
        yield* Effect.forkChild(Fiber.interrupt(first), { startImmediately: true });
        const second = yield* Effect.forkChild(instance.shutdown);
        yield* Deferred.succeed(resume, undefined);
        while (second.pollUnsafe() === undefined || tasks.length > 0) {
          for (const task of tasks.splice(0)) task();
          yield* Effect.yieldNow;
        }
        yield* Fiber.join(second);
        yield* Scope.close(scope, Exit.void);
        expect(log).toEqual(["store:acquire", "tools:register", "shutdown:begin", "store:release"]);
      }),
  );

  it.effect("launches a shutdown whose first caller left right after closing admission", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const notified = yield* Deferred.make<void>();
      const app = Mitome.make({
        agent: Agent.make({ program: () => Effect.succeed("") }),
        provide: layer(log),
      });
      const scope = yield* Scope.make();
      const instance = yield* app
        .acquire({
          onShutdown: Effect.andThen(
            Effect.sync(() => void log.push("shutdown")),
            Deferred.succeed(notified, undefined),
          ),
        })
        .pipe(Scope.provide(scope));

      // A scheduler that yields the first caller at every instruction and holds the queued tasks
      // for the test, which steps that caller until admission is closed and interrupts it there.
      const tasks: Array<() => void> = [];
      let caller: Fiber.Fiber<unknown, unknown> | undefined;
      const scheduler: Scheduler.Scheduler = {
        executionMode: "async",
        shouldYield: (fiber) => fiber === (caller ??= fiber),
        makeDispatcher: () => ({
          scheduleTask: (task) => void tasks.push(task),
          flush: () => {},
        }),
      };
      const first = yield* Effect.forkChild(
        instance.shutdown.pipe(Effect.provideService(Scheduler.Scheduler, scheduler)),
        { startImmediately: true },
      );
      const admitting = Effect.map(Effect.exit(instance.provide(Effect.void)), Exit.isSuccess);
      while (tasks.length > 0 && (yield* admitting)) tasks.shift()?.();
      expect(yield* admitting).toBe(false);
      yield* Effect.forkChild(Fiber.interrupt(first), { startImmediately: true });
      while (first.pollUnsafe() === undefined || tasks.length > 0) {
        for (const task of tasks.splice(0)) task();
        yield* Effect.yieldNow;
      }
      // The shutdown that caller launched began without any later call.
      yield* Deferred.await(notified);
      yield* instance.shutdown;
      yield* Scope.close(scope, Exit.void);
      expect(log).toEqual(["store:acquire", "tools:register", "shutdown", "store:release"]);
    }),
  );

  it.effect("refuses a Turn on an allocated Session as soon as shutdown starts", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const resume = yield* Deferred.make<void>();
      const app = Mitome.make({
        agent: Agent.make({
          program: (label: string) => Effect.sync(() => (log.push(`turn:${label}`), label)),
        }),
        provide: layer(log),
      });
      const scope = yield* Scope.make();
      const instance = yield* app
        .acquire({ onShutdown: Deferred.await(resume) })
        .pipe(Scope.provide(scope));
      const idle = yield* instance.session();
      const shutdown = yield* Effect.forkChild(instance.shutdown, { startImmediately: true });
      expect(yield* Effect.flip(idle.run("late"))).toBeInstanceOf(MitomeClosedError);
      expect(log).not.toContain("turn:late");
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(shutdown);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("keeps the layer live while a Session close whose caller was interrupted drains", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const cleaning = yield* Deferred.make<void>();
      const app = Mitome.make({
        agent: Agent.make({
          program: () =>
            Effect.gen(function* () {
              const store = yield* Store;
              yield* Effect.addFinalizer(() =>
                Effect.andThen(
                  Effect.andThen(Deferred.succeed(cleaning, undefined), Deferred.await(release)),
                  Effect.sync(() => void log.push(`cleanup:${store.read("k")}`)),
                ),
              );
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            }),
        }),
        provide: layer(log),
      });
      const scope = yield* Scope.make();
      const notified = yield* Deferred.make<void>();
      const instance = yield* app
        .acquire({ onShutdown: Deferred.succeed(notified, undefined) })
        .pipe(Scope.provide(scope));
      const session = yield* instance.session();
      yield* Effect.forkChild(session.run(""));
      yield* Deferred.await(started);

      const closing = yield* Effect.forkChild(session.close);
      yield* Deferred.await(cleaning);
      yield* Fiber.interrupt(closing);
      const shutdown = yield* Effect.forkChild(instance.shutdown);
      yield* Deferred.await(notified);
      expect(shutdown.pollUnsafe()).toBeUndefined();
      expect(log).not.toContain("store:release");

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(shutdown);
      expect(log.slice(-2)).toEqual(["cleanup:value of k", "store:release"]);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("finishes a Session close whose caller was interrupted on its own, once", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const cleaning = yield* Deferred.make<void>();
      const cleaned = yield* Deferred.make<void>();
      const app = Mitome.make({
        agent: Agent.make({
          program: () =>
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(cleaning, undefined);
                  yield* Deferred.await(release);
                  log.push("cleanup");
                  yield* Deferred.succeed(cleaned, undefined);
                }),
              );
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            }),
        }),
        provide: layer(log),
      });
      const scope = yield* Scope.make();
      const instance = yield* app.acquire().pipe(Scope.provide(scope));
      const session = yield* instance.session();
      yield* Effect.forkChild(session.run(""));
      yield* Deferred.await(started);

      const closing = yield* Effect.forkChild(session.close);
      yield* Deferred.await(cleaning);
      yield* Fiber.interrupt(closing);
      yield* Deferred.succeed(release, undefined);
      // Nothing but the close the interrupted caller started finishes the cleanup.
      yield* Deferred.await(cleaned);
      // Later callers find the close finished; nothing of the Session runs again.
      yield* session.close;
      yield* instance.shutdown;
      yield* Scope.close(scope, Exit.void);
      expect(log.filter((entry) => entry === "cleanup")).toEqual(["cleanup"]);
      expect(log.at(-1)).toBe("store:release");
    }),
  );

  it.effect("cancels a Session still being built and awaits it before releasing the layer", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const building = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const slow = Extension.make(
        "slow",
        Effect.gen(function* () {
          const store = yield* Store;
          // It never finishes; its interruption still uses the store before letting go.
          return yield* Effect.onInterrupt(
            Effect.andThen(Deferred.succeed(building, undefined), Effect.never),
            () =>
              Effect.andThen(
                Effect.andThen(Deferred.succeed(interrupted, undefined), Deferred.await(release)),
                Effect.sync(() => void log.push(`builder:interrupted:${store.read("k")}`)),
              ),
          );
        }),
      );
      const app = Mitome.make({
        agent: Agent.make({ use: [slow], program: (input: string) => Effect.succeed(input) }),
        provide: layer(log),
      });
      const scope = yield* Scope.make();
      const instance = yield* app.acquire().pipe(Scope.provide(scope));
      const allocating = yield* Effect.forkChild(instance.session());
      yield* Deferred.await(building);

      const shutdown = yield* Effect.forkChild(instance.shutdown);
      yield* Deferred.await(interrupted);
      // The builder was interrupted but still holds the store, so nothing was released yet.
      expect(shutdown.pollUnsafe()).toBeUndefined();
      expect(log).not.toContain("store:release");

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(shutdown);
      expect(log.slice(-2)).toEqual(["builder:interrupted:value of k", "store:release"]);
      expect(Exit.hasInterrupts(yield* Fiber.await(allocating))).toBe(true);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("unwinds a startup that fails after partial acquisition", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const app = Mitome.make({
        agent: Agent.make({
          program: () => Effect.succeed(""),
        }),
        provide: layer(log),
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

  it.effect("closes the layer with the failure of a failed startup", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const exitAware = Layer.effectDiscard(
        Effect.acquireRelease(Effect.void, (_, exit) =>
          Effect.sync(() => void log.push(`infra:${exit._tag}`)),
        ),
      );
      const app = Mitome.make({
        agent: Agent.make({
          program: () => Effect.succeed(""),
        }),
        provide: Layer.merge(layer(log), exitAware),
        providers: [scripted([], log, new Set(["broken"]))],
      });
      yield* Effect.flip(Effect.scoped(app.acquire({ model: "scripted/broken" })));
      expect(log).toContain("infra:Failure");

      log.length = 0;
      yield* Effect.scoped(app.acquire({ model: "scripted/fine" }));
      expect(log).toContain("infra:Success");
    }),
  );

  it.effect("reports a failed startup as a defect when releasing what it acquired dies", () =>
    Effect.gen(function* () {
      const cleanup = new Error("release");
      const app = Mitome.make({
        agent: Agent.make({ program: () => Effect.succeed("") }),
        provide: Layer.effectDiscard(Effect.acquireRelease(Effect.void, () => Effect.die(cleanup))),
        providers: [scripted([], [], new Set(["broken"]))],
      });
      const exit = yield* Effect.exit(Effect.scoped(app.acquire({ model: "scripted/broken" })));
      // A Cause that contains a defect keeps no typed failure: the provisioning failure is one too.
      const reasons = Exit.isFailure(exit) ? exit.cause.reasons : [];
      expect(reasons.map((reason) => (Cause.isDieReason(reason) ? reason.defect : reason))).toEqual(
        ["broken unavailable", cleanup],
      );
    }),
  );

  it.effect("closes what a Session's setups acquired with the failure of its failed startup", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const acquiring = Extension.make(
        "acquiring",
        Effect.as(
          Effect.acquireRelease(Effect.void, (_, exit) =>
            Effect.sync(() => void log.push(`extension:${exit._tag}`)),
          ),
          {},
        ),
      );
      const broken = Extension.make("broken", Effect.fail("setup unavailable"));
      const app = Mitome.make({
        agent: Agent.make({
          use: [acquiring, broken],
          program: (input: string) => Effect.succeed(input),
        }),
      });
      const failure = yield* Effect.scoped(
        Effect.flatMap(app.acquire(), (instance) => Effect.flip(instance.session())),
      );
      expect(failure).toBe("setup unavailable");
      expect(log).toEqual(["extension:Failure"]);
    }),
  );

  it.effect("keeps a provisioning defect a defect and releases what was acquired", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const defective = Provider.make("defective", {
        modelIds: [],
        provision: () =>
          Layer.effect(LanguageModel.LanguageModel, Effect.die(new Error("provision bug"))),
      });
      const app = Mitome.make({
        agent: Agent.make({ program: () => Effect.succeed("") }),
        provide: layer(log),
        providers: [defective],
        model: "defective/any",
      });
      const exit = yield* Effect.exit(Effect.scoped(app.acquire()));
      expect(Exit.hasDies(exit)).toBe(true);
      expect(log.at(-1)).toBe("store:release");
    }),
  );

  it.effect("still releases everything when the shutdown notification fails", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const app = Mitome.make({
        agent: Agent.make({
          program: () => Effect.succeed(""),
        }),
        provide: layer(log),
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

  it.effect("runs each Session's Agent with its Extensions, the layer and the Model", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const Remember = Tool.make("remember", {
        parameters: Schema.Struct({ key: Schema.String }),
        success: Schema.String,
        needsApproval: true,
      });
      const Recall = Tool.make("recall", {
        parameters: Schema.Struct({ key: Schema.String }),
        success: Schema.String,
      });
      const MemoryKit = Toolkit.make(Remember, Recall);
      // The Configuration's services may not answer Approvals.
      const allowAll = Layer.succeed(Approver, { decide: () => Effect.succeed("allow") });
      const memory = Extension.make(
        "memory",
        Effect.gen(function* () {
          const recall = yield* Effect.acquireRelease(
            Effect.map(Store, ({ read }) => (log.push("memory:acquire"), read)),
            () => Effect.sync(() => void log.push("memory:release")),
          );
          return {
            tools: MemoryKit,
            handlers: MemoryKit.of({
              remember: ({ key }) => Effect.sync(() => (log.push(`remember:${key}`), key)),
              recall: ({ key }) => Effect.sync(() => recall(key)),
            }),
          };
        }),
      );
      const shared = Layer.merge(layer(log), allowAll);
      const app = Mitome.make({
        agent: Agent.make({ use: [memory] }),
        provide: shared,
        providers: [
          scripted(
            [
              [call("c1", "remember", "k"), call("c2", "recall", "k"), finish("tool-calls")],
              [text("done"), finish("stop")],
            ],
            log,
          ),
        ],
        model: "scripted/fixed",
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const instance = yield* app.acquire();
          const session = yield* instance.session();
          expect(log.at(-1)).toBe("memory:acquire");
          expect(yield* session.run("remember k")).toBe("done");
          const history = JSON.stringify(yield* session.history);
          expect(history).toContain("Tool call needs approval and nobody is present to give it");
          expect(history).toContain("value of k");
          expect(log).not.toContain("remember:k");
          // What the setup acquired belongs to the Session; the Configuration's services outlive it.
          yield* session.close;
          expect(log.at(-1)).toBe("memory:release");
        }),
      );
      expect(log.at(-1)).toBe("store:release");
    }),
  );

  it.effect("builds each Layer of a provided list once per acquisition", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      class Greeting extends Context.Service<Greeting, { readonly text: string }>()(
        "test/Greeting",
      ) {}
      const greeting = Layer.effect(
        Greeting,
        Effect.acquireRelease(
          Effect.sync(() => (log.push("greeting:acquire"), { text: "hi" })),
          () => Effect.sync(() => void log.push("greeting:release")),
        ),
      );
      const app = Mitome.make({
        agent: Agent.make({
          program: (input: string) =>
            Effect.map(
              Effect.zip(Store, Greeting),
              ([store, { text }]) => `${text} ${store.read(input)}`,
            ),
        }),
        provide: [layer(log), greeting],
      });
      const acquisition = Effect.scoped(
        Effect.gen(function* () {
          const instance = yield* app.acquire();
          const one = yield* instance.session();
          const two = yield* instance.session();
          return [yield* one.run("a"), yield* two.run("b")];
        }),
      );
      expect(yield* acquisition).toEqual(["hi value of a", "hi value of b"]);
      expect([...log].sort()).toEqual([
        "greeting:acquire",
        "greeting:release",
        "store:acquire",
        "store:release",
        "tools:register",
      ]);
      log.length = 0;
      yield* acquisition;
      expect([...log].sort()).toEqual([
        "greeting:acquire",
        "greeting:release",
        "store:acquire",
        "store:release",
        "tools:register",
      ]);
    }),
  );

  it.effect("gives each Command call of a configured Session a Scope of its own", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const holding = Extension.make("holding", {
        commands: [
          Command.make("hold", {
            description: "Hold something",
            run: (input) =>
              Effect.gen(function* () {
                const { read } = yield* Store;
                yield* Effect.addFinalizer(() => Effect.sync(() => void log.push("released")));
                return Command.reply(read(input));
              }),
          }),
        ],
      });
      const app = Mitome.make({
        agent: Agent.make({ use: [holding], program: (input: string) => Effect.succeed(input) }),
        provide: layer(log),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const instance = yield* app.acquire();
          const session = yield* instance.session();
          expect(yield* session.command("hold", "k")).toEqual(Command.reply("value of k"));
          expect(log.at(-1)).toBe("released");
        }),
      );
    }),
  );

  it.effect("keeps its own copy of a provided list", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const layers: [ReturnType<typeof layer>] = [layer(log)];
      const app = Mitome.make({
        agent: Agent.make({
          program: (input: string) => Effect.map(Store, (store) => store.read(input)),
        }),
        provide: layers,
      });
      layers.pop();
      expect(Object.isFrozen(app.provide)).toBe(true);
      const result = yield* Effect.scoped(
        Effect.flatMap(app.acquire(), (instance) =>
          Effect.flatMap(instance.session(), (session) => session.run("k")),
        ),
      );
      expect(result).toBe("value of k");
    }),
  );

  it.effect(
    "runs a Session's Commands with the provided services until it or the instance closes",
    () =>
      Effect.gen(function* () {
        const log: Array<string> = [];
        const reading = Extension.make(
          "reading",
          Effect.gen(function* () {
            const { read } = yield* Store;
            return {
              commands: [
                Command.make("read", {
                  description: "Read a key",
                  run: (input) => Effect.succeed(Command.reply(read(input))),
                }),
              ],
            };
          }),
        );
        const app = Mitome.make({
          agent: Agent.make({ use: [reading], program: (input: string) => Effect.succeed(input) }),
          provide: layer(log),
        });
        const scope = yield* Scope.make();
        const instance = yield* app.acquire().pipe(Scope.provide(scope));
        const session = yield* instance.session();
        expect(session.commands).toEqual([
          { name: "read", description: "Read a key", extension: "reading" },
        ]);
        expect(yield* session.command("read", "k")).toEqual(Command.reply("value of k"));
        const closed = yield* instance.session();
        yield* closed.close;
        expect(yield* Effect.flip(closed.command("read", "k"))).toEqual(new SessionReleasedError());
        yield* instance.shutdown;
        expect(yield* Effect.flip(session.command("read", "k"))).toEqual(new MitomeClosedError());
        expect(log.at(-1)).toBe("store:release");
        yield* Scope.close(scope, Exit.void);
      }),
  );

  it.effect("resolves the Agent's text mapping, or the identity for text", () =>
    Effect.gen(function* () {
      const counted = Agent.make({
        program: (input: string) => Effect.succeed(input.length),
        text: { parse: Effect.succeed, render: (n) => Effect.succeed(`${n} characters`) },
      });
      const configured = Mitome.make({ agent: counted }).text;
      expect(yield* configured.parse("hello")).toBe("hello");
      expect(yield* configured.render(5)).toBe("5 characters");

      const echo = Mitome.make({
        agent: Agent.make({ program: (input: string) => Effect.succeed(input) }),
      });
      expect(yield* echo.text.parse("hi")).toBe("hi");
      expect(yield* echo.text.render("hi")).toBe("hi");
      // SAFETY: deliberately mistyped, so the runtime check sees a result the types would reject.
      const failure = yield* Effect.flip(echo.text.render(42 as never));
      expect(failure).toBeInstanceOf(TextMappingError);
    }),
  );

  it("keeps a field the options inherit, such as a class's Model", () => {
    const log: Array<string> = [];
    const agent = Agent.make({ program: () => Effect.succeed("") });
    class Options {
      readonly agent = agent;
      readonly providers = [scripted([], log)] as const;
      get model() {
        return "scripted/fixed" as const;
      }
    }
    expect(Mitome.make(new Options()).model).toBe("scripted/fixed");
  });

  it("rejects an Agent copied without Agent.make", () => {
    const agent = Agent.make({ program: (input: string) => Effect.succeed(input) });
    expect(() => Mitome.make({ agent: { ...agent } })).toThrow(
      "Mitome.make expects an Agent made by Agent.make",
    );
  });
});

describe("Mitome.make Model selection", () => {
  const selecting = (log: Array<string>, fail: ReadonlySet<string> = new Set()) =>
    Mitome.make({
      agent: Agent.make({
        program: () => Effect.succeed(""),
      }),
      provide: layer(log),
      providers: [scripted([], log, fail), scripted([], log, fail, "spare")],
      model: "scripted/fixed",
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

  it.effect("provisions an explicit unlisted Model id as-is and returns its failure", () =>
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

      // The configured Model's failure is returned the same way, and released.
      log.length = 0;
      expect(yield* Effect.flip(acquired(selecting(log, new Set(["fixed"])), {}))).toBe(
        "fixed unavailable",
      );
      expect(log.filter((entry) => /^(provision|release):/.test(entry))).toEqual([
        "provision:scripted/fixed",
        "release:scripted/fixed",
      ]);
    }),
  );

  it.effect("discovers and acquires the Providers it was given, whatever happens to the list", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const providers = [scripted([], log), scripted([], log, new Set(), "spare")];
      const app = Mitome.make({
        agent: Agent.make({ program: () => Effect.succeed("") }),
        providers,
        model: "scripted/fixed",
      });
      providers.splice(0, 1);
      expect(app.providers?.map(({ id }) => id)).toEqual(["scripted", "spare"]);
      expect(app.discovery.map(({ id }) => id)).toEqual(["scripted", "spare"]);
      yield* Effect.scoped(app.acquire());
      expect(log).toContain("provision:scripted/fixed");
    }),
  );

  it.effect("requires a selectable Model when Providers are declared", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const app = Mitome.make({
        agent: Agent.make({
          program: () => Effect.succeed(""),
        }),
        providers: [scripted([], log)],
      });
      expect(yield* Effect.flip(Effect.scoped(app.acquire()))).toBeInstanceOf(ModelSelectionError);
      expect(log).toEqual([]);
    }),
  );

  it.effect("rejects a default program without a Model before its first Turn and releases", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const none: Array<ReturnType<typeof scripted>> = [];
      const app = Mitome.make({
        agent: Agent.make({}),
        provide: layer(log),
        // SAFETY: deliberately mistyped, so the runtime check sees an empty list the types reject.
        providers: none as [ReturnType<typeof scripted>],
      });
      const failure = yield* Effect.flip(Effect.scoped(app.acquire()));
      expect(failure).toBeInstanceOf(ModelSelectionError);
      expect(String(failure)).toContain("provides no Model");
      expect(log).toEqual(["store:acquire", "tools:register", "store:release"]);
    }),
  );

  it.effect("runs a default program on a Model the Configuration's layer provides", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const app = Mitome.make({
        agent: Agent.make({}),
        provide: Provider.model(scripted([[text("from the layer"), finish("stop")]], log), "fixed"),
      });
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const instance = yield* app.acquire();
          const session = yield* instance.session();
          return yield* session.run("hi");
        }),
      );
      expect(result).toBe("from the layer");
      expect(log).toEqual(["provision:scripted/fixed", "generate:1", "release:scripted/fixed"]);
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
      Mitome.make({
        agent: Agent.make({
          program: () => Effect.succeed(""),
        }),
        providers: [scripted([], log), scripted([], log)],
      }),
    ).toThrow('Duplicate Provider id "scripted"');
    expect(() =>
      Mitome.make({
        agent: Agent.make({
          program: () => Effect.succeed(""),
        }),
        providers: [scripted([], log)],
        // SAFETY: deliberately mistyped, so the runtime check sees an id the types would reject.
        model: "scriptedfixed" as "scripted/fixed",
      }),
    ).toThrow("names no declared Provider");
  });
});
