import * as BunTerminal from "@effect/platform-bun/BunTerminal";
import { type Cause, Console, Effect, Layer, Queue, Runtime, Terminal } from "effect";

class ReportedError extends Error {
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

// The Bun terminal never ends its input queue at stdin EOF, so every prompt
// after EOF waits forever. Ending the queue on stdin "end" makes prompts fail
// with their documented QuitError; buffered keypresses still deliver first.
// TODO: delete this layer once NodeTerminal ends its queue on stdin EOF (effect#4895).
let stdinEnded = false; // "end" fires once per process and Bun never sets readableEnded
export const promptTerminal = Layer.effect(
  Terminal.Terminal,
  Effect.map(BunTerminal.make(), (terminal) =>
    Terminal.make({
      ...terminal,
      readInput: terminal.readInput.pipe(
        Effect.tap((input) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              const end = () => {
                stdinEnded = true;
                Queue.endUnsafe(input as Queue.Queue<Terminal.UserInput, Cause.Done>);
              };
              if (stdinEnded) end();
              else process.stdin.once("end", end);
              return end;
            }),
            (end) => Effect.sync(() => process.stdin.off("end", end)),
          ),
        ),
      ),
    }),
  ),
);
