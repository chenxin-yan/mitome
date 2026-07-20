import { Effect } from "effect";
import { AiError } from "effect/unstable/ai";
import type { AnyPlugin } from "./definition.js";
import { TurnError } from "./errors.js";
import { coreModuleName } from "./tool-runtime.js";

export const hookTurnError = (message: string) =>
  Effect.mapError((cause: unknown) => new TurnError({ message, cause }));

export const modelTurnError = (cause: unknown) =>
  new TurnError({
    message:
      AiError.isAiError(cause) && cause.module === coreModuleName
        ? cause.reason.message
        : "Turn failed",
    cause,
  });

const logHookFailure = (message: string) =>
  Effect.catchCause((cause) => Effect.logWarning(message, cause));

export interface HookProgress {
  dispatched: number;
}

export const runCleanupHooks = (
  plugins: ReadonlyArray<AnyPlugin>,
  getHook: (plugin: AnyPlugin) => Effect.Effect<void, unknown> | undefined,
  message: string,
): Effect.Effect<void> =>
  Effect.forEach(
    plugins,
    (plugin) => (getHook(plugin) ?? Effect.void).pipe(logHookFailure(message)),
    { discard: true },
  );

export const runStartHooks = (
  plugins: ReadonlyArray<AnyPlugin>,
  getStart: (plugin: AnyPlugin) => Effect.Effect<void, unknown> | undefined,
  getEnd: (plugin: AnyPlugin) => Effect.Effect<void, unknown> | undefined,
  endFailureMessage: string,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    let started = 0;
    const start = Effect.gen(function* () {
      for (const plugin of plugins) {
        yield* getStart(plugin) ?? Effect.void;
        started += 1;
      }
    });
    return yield* start.pipe(
      Effect.onError(() => runCleanupHooks(plugins.slice(0, started), getEnd, endFailureMessage)),
    );
  });

export const runEndHooks = (
  plugins: ReadonlyArray<AnyPlugin>,
  getHook: (plugin: AnyPlugin) => Effect.Effect<void, unknown> | undefined,
  progress: HookProgress,
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
