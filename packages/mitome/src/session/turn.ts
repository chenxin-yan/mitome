import { Context, Exit, Result, Schema, Struct } from "effect";
import type { Effect, Types } from "effect";
import type { Prompt } from "effect/ai";
import type { SessionFencedError, SessionReleasedError, SessionSaveError } from "./errors.js";
import type { Session } from "./session.js";

/**
 * The active Turn, supplied to the program `Session.run` invokes. Ordinary nested functions that
 * yield it share that same Turn and Session; running work in another Session is an explicit `run`
 * call there, which supplies that Session's Turn for its duration only.
 */
export class Turn extends Context.Service<
  Turn,
  {
    /** Live identity of this Turn; not a durable receipt or an authorization token. */
    readonly id: string;
    /** The Session that owns this Turn, with every persistence error a Session can raise. */
    readonly session: Session<SessionSaveError | SessionFencedError>;
    /**
     * Adds Messages to this Turn's staged conversation. They commit as one Entry with the next
     * controlled Step that completes, or when the program succeeds, and are dropped if it fails
     * first. Staging through a Turn after it closed is a defect.
     */
    readonly stage: (...messages: ReadonlyArray<Prompt.Message>) => Effect.Effect<void>;
    /**
     * What this root Turn's controlled Steps have consumed. It stays readable after the Turn ends,
     * while its Session lives, and fails once the Session is released.
     */
    readonly usage: Effect.Effect<ExecutionUsage, SessionReleasedError>;
  }
>()("mitome/Turn") {}

/**
 * Bounds on one root Turn's controlled work. A bound left out is no limit on that count; one given
 * is a non-negative integer. Any other key is refused.
 */
export interface ExecutionLimits {
  /** Controlled Model generation calls, each reserved before its request whatever its outcome. */
  readonly generations?: number;
  /** Local Tool handler dispatches, each reserved before the handler is entered. */
  readonly dispatches?: number;
}

/**
 * What given `ExecutionLimits` must be: each bound absent, `undefined` or a non-negative safe
 * integer, and no other key, since a misspelled bound would leave that count without a limit.
 */
const ExecutionLimitsSchema = Schema.Struct({
  generations: Schema.optional(Schema.Natural),
  dispatches: Schema.optional(Schema.Natural),
});
const decodeLimits = Schema.decodeUnknownExit(ExecutionLimitsSchema, { onExcessProperty: "error" });

/**
 * A copy of given limits, without the bounds that are `undefined`, or what is wrong with them, said
 * after "limits". Decoding reads each bound once by name, so one that is inherited or behind a
 * getter counts, and refuses an own key that names no bound.
 */
export const readLimits = (given: ExecutionLimits): Result.Result<ExecutionLimits, string> => {
  const decoded = decodeLimits(given);
  if (Exit.isFailure(decoded)) {
    const unknown = Object.keys(given).find(
      (key) => !Object.hasOwn(ExecutionLimitsSchema.fields, key),
    );
    return Result.fail(
      unknown === undefined ? "must be non-negative integers" : `have no bound "${unknown}"`,
    );
  }
  const limits: Types.Mutable<ExecutionLimits> = {};
  for (const bound of Struct.keys(ExecutionLimitsSchema.fields)) {
    const value = decoded.value[bound];
    if (value !== undefined) {
      limits[bound] = value;
    }
  }
  return Result.succeed(limits);
};

/**
 * One root Turn's accounting. `physicalRequests` counts Provider requests the Model binding
 * reported for controlled generations, including its retries and native fallback; it has no bound.
 */
export interface ExecutionUsage {
  readonly generations: number;
  readonly dispatches: number;
  readonly physicalRequests: number;
}
