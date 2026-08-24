import { Console, Effect, Runtime } from "effect";

export class CliError extends Error {
  override readonly [Runtime.errorReported] = false;
}

export type ExitCode = number;

interface ErrorDetails {
  readonly _tag?: string;
  readonly message?: string;
  readonly cause?: Error | ErrorDetails;
}

// The embedded Child Host cannot import this module, so hosts/host.ts keeps the sibling renderer.
// JSON.stringify throws on BigInt values and circular structures; a throwing
// formatter would mask the error being reported, so fall back to Bun's renderer.
const safeJson = (value: Error | ErrorDetails | null): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return Bun.inspect(value);
  }
};

const errorMessage = (error: Error | ErrorDetails): string => {
  const head =
    "_tag" in error && "message" in error
      ? `${String(error._tag)}: ${String(error.message)}`
      : error instanceof Error
        ? error.message
        : safeJson(error);
  const cause = error.cause;
  if (cause === undefined) return head;
  return `${head}\n  cause: ${cause !== null && cause instanceof Object ? errorMessage(cause) : safeJson(cause)}`;
};

export const attempt = <A>(promise: () => Promise<A>) =>
  Effect.tryPromise({
    try: promise,
    catch: (error) => {
      if (!(error instanceof Object)) return new CliError(String(error));
      return new CliError(errorMessage(error));
    },
  }).pipe(Effect.tapError((error) => Console.error(error.message)));

export const fail = (message: string) =>
  Console.error(message).pipe(Effect.andThen(Effect.fail(new CliError(message))));
