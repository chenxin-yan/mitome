import { Predicate } from "effect";

/**
 * What a failed compiler run printed, from the rejection of `promisify(execFile)`: tsc prints its
 * diagnostics on stdout, which the rejection's own message leaves out.
 */
export const compilerOutput = (cause: unknown): string =>
  Predicate.hasProperty(cause, "stdout") && Predicate.hasProperty(cause, "stderr")
    ? `${String(cause.stdout)}${String(cause.stderr)}`
    : String(cause);
