import { Console, Effect, Runtime } from "effect";

export class CliError extends Error {
  override readonly [Runtime.errorReported] = false;
}

export type ExitCode = number;

// The embedded Child Host cannot import this module, so hosts/host.ts keeps the sibling renderer.
const errorMessage = (error: unknown): string => {
  const head =
    typeof error === "object" && error !== null && "_tag" in error && "message" in error
      ? `${String(error._tag)}: ${String(error.message)}`
      : error instanceof Error
        ? error.message
        : String(error);
  const cause =
    typeof error === "object" && error !== null && "cause" in error ? error.cause : undefined;
  return cause === undefined ? head : `${head}\n  cause: ${errorMessage(cause)}`;
};

export const attempt = <A>(promise: () => Promise<A>) =>
  Effect.tryPromise({
    try: promise,
    catch: (error) => new CliError(errorMessage(error)),
  }).pipe(Effect.tapError((error) => Console.error(error.message)));

export const fail = (message: string) =>
  Console.error(message).pipe(Effect.andThen(Effect.fail(new CliError(message))));
