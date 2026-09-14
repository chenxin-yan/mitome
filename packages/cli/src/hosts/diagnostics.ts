// Shared by the embedded Runner programs: child-host.ts splices this file's text in place
// of each program's import, so it must stay free of imports. The parent CLI cannot share
// it (see support.ts).
interface ErrorDetails {
  readonly _tag?: string;
  readonly message?: string;
  readonly cause?: Error | ErrorDetails;
}

// JSON.stringify throws on BigInt values and circular structures; a throwing
// formatter would mask the error being reported, so fall back to Bun's renderer.
const safeJson = (value: Error | ErrorDetails | null): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return Bun.inspect(value);
  }
};

// User-thrown errors may point `cause` back at themselves; `seen` stops that recursion.
export const errorMessage = (
  error: Error | ErrorDetails,
  seen: Set<Error | ErrorDetails> = new Set(),
): string => {
  if (seen.has(error)) return "[circular cause]";
  seen.add(error);
  const head =
    "_tag" in error && "message" in error
      ? `${String(error._tag)}: ${String(error.message)}`
      : error instanceof Error
        ? error.message
        : safeJson(error);
  const cause = error.cause;
  if (cause === undefined) return head;
  return `${head}\n  cause: ${cause !== null && cause instanceof Object ? errorMessage(cause, seen) : safeJson(cause)}`;
};
