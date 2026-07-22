import { Effect } from "effect";
import { Prompt } from "effect/unstable/ai";
import type { AnyPlugin, PluginContexts } from "../plugin.js";
import { providePlugin } from "../plugin.js";

const logHookFailure = (message: string) =>
  Effect.catchCause((cause) => Effect.logWarning(message, cause));

export const transformPrompt = (
  plugins: ReadonlyArray<AnyPlugin>,
  contexts: PluginContexts,
  prompt: Prompt.Prompt,
): Effect.Effect<Prompt.Prompt, unknown> =>
  Effect.gen(function* () {
    let current = prompt;
    for (const plugin of plugins) {
      current = yield* providePlugin(
        plugin,
        contexts,
        plugin.hooks?.preStep?.(current) ?? Effect.succeed(current),
      );
    }
    return current;
  });

export interface HookPhase {
  readonly end: Effect.Effect<void, unknown>;
  readonly cleanup: Effect.Effect<void>;
}

const runCleanupHooks = (
  plugins: ReadonlyArray<AnyPlugin>,
  getHook: (plugin: AnyPlugin) => Effect.Effect<void, unknown> | undefined,
  message: string,
): Effect.Effect<void> =>
  Effect.forEach(
    plugins,
    (plugin) => (getHook(plugin) ?? Effect.void).pipe(logHookFailure(message)),
    { discard: true },
  );

const runEndHooks = (
  plugins: ReadonlyArray<AnyPlugin>,
  getHook: (plugin: AnyPlugin) => Effect.Effect<void, unknown> | undefined,
  progress: { dispatched: number },
  failureMessage: string,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    let failed = false;
    let firstFailure: unknown;
    for (const plugin of plugins) {
      // Interruption must continue with later cleanup, not invoke the active Hook twice.
      progress.dispatched += 1;
      const hook = getHook(plugin) ?? Effect.void;
      if (failed) {
        yield* hook.pipe(Effect.catch((failure) => Effect.logWarning(failureMessage, failure)));
      } else {
        yield* hook.pipe(
          Effect.catch((failure) =>
            Effect.sync(() => {
              failed = true;
              firstFailure = failure;
            }),
          ),
        );
      }
    }
    if (failed) return yield* Effect.fail(firstFailure);
  });

export const beginHookPhase = (
  plugins: ReadonlyArray<AnyPlugin>,
  getStart: (plugin: AnyPlugin) => Effect.Effect<void, unknown> | undefined,
  getEnd: (plugin: AnyPlugin) => Effect.Effect<void, unknown> | undefined,
  endFailureMessage: string,
): Effect.Effect<HookPhase, unknown> =>
  Effect.gen(function* () {
    let started = 0;
    const start = Effect.gen(function* () {
      for (const plugin of plugins) {
        yield* getStart(plugin) ?? Effect.void;
        started += 1;
      }
    });
    yield* start.pipe(
      Effect.onError(() => runCleanupHooks(plugins.slice(0, started), getEnd, endFailureMessage)),
    );

    const progress = { dispatched: 0 };
    return {
      end: runEndHooks(plugins, getEnd, progress, endFailureMessage),
      cleanup: Effect.suspend(() =>
        runCleanupHooks(plugins.slice(progress.dispatched), getEnd, endFailureMessage),
      ),
    };
  });
