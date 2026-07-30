import { Effect } from "effect";
import { Prompt } from "effect/unstable/ai";
import type { AnyPlugin, PluginContexts } from "../plugin.js";
import { providePlugin } from "../plugin.js";

export const transformPrompt: (
  plugins: ReadonlyArray<AnyPlugin>,
  contexts: PluginContexts,
  prompt: Prompt.Prompt,
) => Effect.Effect<Prompt.Prompt, unknown> = Effect.fn("@mitome/core/transformPrompt")(
  function* (plugins, contexts, prompt) {
    let current = prompt;
    for (const plugin of plugins) {
      current = yield* providePlugin(
        plugin,
        contexts,
        plugin.hooks?.preStep?.(current) ?? Effect.succeed(current),
      );
    }
    return current;
  },
);

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
    (plugin) =>
      (getHook(plugin) ?? Effect.void).pipe(
        Effect.catchCause((cause) => Effect.logWarning(message, cause)),
      ),
    { discard: true },
  );

const runEndHooks = (
  plugins: ReadonlyArray<AnyPlugin>,
  getHook: (plugin: AnyPlugin) => Effect.Effect<void, unknown> | undefined,
  progress: { dispatched: number },
  failureMessage: string,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    // Boxed so "no failure yet" is distinguishable from a failure value of undefined.
    let firstFailure: { readonly failure: unknown } | undefined = undefined;
    for (const plugin of plugins) {
      // Interruption must continue with later cleanup, not invoke the active Hook twice.
      progress.dispatched += 1;
      const hook = getHook(plugin) ?? Effect.void;
      if (firstFailure === undefined) {
        firstFailure = yield* hook.pipe(
          Effect.as(undefined),
          Effect.catch((failure) => Effect.succeed({ failure })),
        );
      } else {
        yield* hook.pipe(Effect.catch((failure) => Effect.logWarning(failureMessage, failure)));
      }
    }
    if (firstFailure !== undefined) return yield* Effect.fail(firstFailure.failure);
  });

export const beginHookPhase: (
  plugins: ReadonlyArray<AnyPlugin>,
  getStart: (plugin: AnyPlugin) => Effect.Effect<void, unknown> | undefined,
  getEnd: (plugin: AnyPlugin) => Effect.Effect<void, unknown> | undefined,
  endFailureMessage: string,
) => Effect.Effect<HookPhase, unknown> = Effect.fn("@mitome/core/beginHookPhase")(
  function* (plugins, getStart, getEnd, endFailureMessage) {
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
  },
);
