import { Console, Effect, Runtime } from "effect";

export class CliError extends Error {
  override readonly [Runtime.errorReported] = false;
}

export type ExitCode = number;

export const attempt = <A>(promise: () => Promise<A>) =>
  Effect.tryPromise({
    try: promise,
    catch: (error) => new CliError(error instanceof Error ? error.message : String(error)),
  }).pipe(Effect.tapError((error) => Console.error(error.message)));

export const fail = (message: string) =>
  Console.error(message).pipe(Effect.andThen(Effect.fail(new CliError(message))));
