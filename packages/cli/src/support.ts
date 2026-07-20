import { Console, Effect, Runtime, Terminal } from "effect";
import { Prompt } from "effect/unstable/cli";

export class ReportedError extends Error {
  override readonly [Runtime.errorReported] = false;
}

export const attempt = <A>(promise: () => Promise<A>) =>
  Effect.tryPromise({
    try: promise,
    catch: (error) => new ReportedError(error instanceof Error ? error.message : String(error)),
  }).pipe(Effect.tapError((error) => Console.error(error.message)));

export const waitForChild = <A>(promise: () => Promise<A>) =>
  Effect.uninterruptible(attempt(promise));

export const fail = (message: string) =>
  Console.error(message).pipe(Effect.andThen(Effect.fail(new ReportedError(message))));

// Prompt.run hangs when beta.98's Bun terminal sees stdin EOF. Defer the
// interruption one tick so a final buffered line can still submit first.
export const runNativePrompt = <A>(prompt: Prompt.Prompt<A>) =>
  Prompt.run(prompt).pipe(
    Effect.raceFirst(
      Effect.callback<never, Terminal.QuitError>((resume) => {
        let pending: ReturnType<typeof setImmediate> | undefined;
        const quit = () => resume(Effect.fail(new Terminal.QuitError({})));
        const onEnd = () => {
          pending = setImmediate(quit);
        };
        if (process.stdin.readableEnded) onEnd();
        else process.stdin.once("end", onEnd);
        return Effect.sync(() => {
          process.stdin.off("end", onEnd);
          if (pending !== undefined) clearImmediate(pending);
        });
      }),
    ),
  );
