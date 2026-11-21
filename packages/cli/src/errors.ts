import type { PlatformError } from "effect";
import { CliError } from "effect/cli";

/** Why something failed, for a one-line diagnostic. */
export const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const userError = (userMessage: string, cause?: unknown) =>
  new CliError.UserError({ cause, userMessage });

/** The runtime's own error under a `PlatformError`: diagnostics quote its message and code. */
export const runtimeError = (
  error: PlatformError.PlatformError | PlatformError.BadArgument,
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- the platform's underlying cause, which can be anything
): unknown => error.cause ?? error;
