import { Effect } from "effect";
import { Prompt } from "effect/unstable/ai";
import type { AnyExtension, ExtensionContexts } from "../extension.js";
import { provideExtension } from "../extension.js";

export const transformPrompt: (
  extensions: ReadonlyArray<AnyExtension>,
  contexts: ExtensionContexts,
  prompt: Prompt.Prompt,
) => Effect.Effect<Prompt.Prompt, unknown> = Effect.fn("@mitome/core/transformPrompt")(
  function* (extensions, contexts, prompt) {
    let current = prompt;
    for (const extension of extensions) {
      current = yield* provideExtension(
        extension,
        contexts,
        extension.hooks?.preStep?.(current) ?? Effect.succeed(current),
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
  extensions: ReadonlyArray<AnyExtension>,
  getHook: (extension: AnyExtension) => Effect.Effect<void, unknown> | undefined,
  message: string,
): Effect.Effect<void> =>
  Effect.forEach(
    extensions,
    (extension) =>
      (getHook(extension) ?? Effect.void).pipe(
        Effect.catchCause((cause) => Effect.logWarning(message, cause)),
      ),
    { discard: true },
  );

const runEndHooks = (
  extensions: ReadonlyArray<AnyExtension>,
  getHook: (extension: AnyExtension) => Effect.Effect<void, unknown> | undefined,
  progress: { dispatched: number },
  failureMessage: string,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    // Boxed so "no failure yet" is distinguishable from a failure value of undefined.
    let firstFailure: { readonly failure: unknown } | undefined = undefined;
    for (const extension of extensions) {
      // Interruption must continue with later cleanup, not invoke the active Hook twice.
      progress.dispatched += 1;
      const hook = getHook(extension) ?? Effect.void;
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
  extensions: ReadonlyArray<AnyExtension>,
  getStart: (extension: AnyExtension) => Effect.Effect<void, unknown> | undefined,
  getEnd: (extension: AnyExtension) => Effect.Effect<void, unknown> | undefined,
  endFailureMessage: string,
) => Effect.Effect<HookPhase, unknown> = Effect.fn("@mitome/core/beginHookPhase")(
  function* (extensions, getStart, getEnd, endFailureMessage) {
    let started = 0;
    const start = Effect.gen(function* () {
      for (const extension of extensions) {
        yield* getStart(extension) ?? Effect.void;
        started += 1;
      }
    });
    yield* start.pipe(
      Effect.onError(() =>
        runCleanupHooks(extensions.slice(0, started), getEnd, endFailureMessage),
      ),
    );

    const progress = { dispatched: 0 };
    return {
      end: runEndHooks(extensions, getEnd, progress, endFailureMessage),
      cleanup: Effect.suspend(() =>
        runCleanupHooks(extensions.slice(progress.dispatched), getEnd, endFailureMessage),
      ),
    };
  },
);
