import { Match, Predicate, Schema } from "effect";

/** `Session.run` while another Turn of the same Session is active, including a nested call. */
export class SessionBusyError extends Schema.TaggedError<
  SessionBusyError,
  { readonly brand: unique symbol }
>()("SessionBusyError", {}) {
  /** Fixed description; the error carries no fields. */
  override get message(): string {
    return "Session is busy with an active Turn";
  }
}

/** Use of a Session whose allocating Scope has closed or is closing. */
export class SessionReleasedError extends Schema.TaggedError<
  SessionReleasedError,
  { readonly brand: unique symbol }
>()("SessionReleasedError", {}) {
  /** Fixed description; the error carries no fields. */
  override get message(): string {
    return "Session scope has been released";
  }
}

/**
 * A commit's outcome is unknown, or another writer moved the stored position, so this Session's
 * view of its Transcript may be stale and it rejects further Turns and moves rather than assume
 * otherwise. Only reconciliation can settle it; this Session cannot.
 */
export class SessionFencedError extends Schema.TaggedError<
  SessionFencedError,
  { readonly brand: unique symbol }
>()("SessionFencedError", {}) {
  /** Fixed description; the error carries no fields. */
  override get message(): string {
    return "Session is fenced by a commit whose outcome is unknown or that another writer refused";
  }
}

/**
 * A Transcript did not store an Entry or move its position. `not-written` asserts nothing was
 * stored, so history is unchanged and the Session stays usable; `conflict` asserts the same but
 * because the stored position was not the expected one, so another writer has moved on and the
 * Session is fenced; `unknown` makes no claim and fences the Session. `cause` is why, when the
 * store knows: a full disk, a lock another process holds.
 */
export class SessionSaveError extends Schema.TaggedError<
  SessionSaveError,
  { readonly brand: unique symbol }
>()("SessionSaveError", {
  outcome: Schema.Literals(["not-written", "conflict", "unknown"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  /** Description derived from `outcome`, followed by the cause's when there is one. */
  override get message(): string {
    const outcome = Match.value(this.outcome).pipe(
      Match.when("not-written", () => "Session save failed without writing"),
      Match.when(
        "conflict",
        () => "Session save was refused: another writer moved the stored position",
      ),
      Match.when("unknown", () => "Session save outcome is unknown"),
      Match.exhaustive,
    );
    const why = this.cause instanceof Error ? this.cause.message : this.cause;
    return Predicate.isString(why) && why !== "" ? `${outcome}: ${why}` : outcome;
  }
}

/** A Transcript could not be read, or has no Entry with the requested id. */
export class TranscriptError extends Schema.TaggedError<
  TranscriptError,
  { readonly brand: unique symbol }
>()("TranscriptError", { detail: Schema.String }) {
  /** Description derived from `detail`. */
  override get message(): string {
    return `Transcript failed: ${this.detail}`;
  }
}

/**
 * A controlled Step would exceed its root Turn's `ExecutionLimits`. Nothing was dispatched for the
 * refused unit; work already reserved stays counted.
 */
export class ExecutionLimitError extends Schema.TaggedError<
  ExecutionLimitError,
  { readonly brand: unique symbol }
>()("ExecutionLimitError", {
  limit: Schema.Literals(["generations", "dispatches"]),
  bound: Schema.Finite,
}) {
  /** Description derived from `limit` and `bound`. */
  override get message(): string {
    return `Turn reached its limit of ${this.bound} ${this.limit === "generations" ? "Model generations" : "local Tool dispatches"}`;
  }
}

/**
 * A controlled Step refused to proceed before any local Tool ran: the Model binding's physical
 * requests are not accounted for (`unsupported-accounting`, before any request), the Prompt
 * carried native approval artifacts (`approval-artifact`, before any request), the response was
 * malformed, contradictory or not plain data (`malformed-response`), or it asked for a
 * continuation Mitome does not support (`unsupported-continuation`).
 */
export class StepProtocolError extends Schema.TaggedError<
  StepProtocolError,
  { readonly brand: unique symbol }
>()("StepProtocolError", {
  reason: Schema.Literals([
    "unsupported-accounting",
    "approval-artifact",
    "malformed-response",
    "unsupported-continuation",
  ]),
  detail: Schema.String,
}) {
  /** Description derived from `reason` and `detail`. */
  override get message(): string {
    return `Controlled Step rejected (${this.reason}): ${this.detail}`;
  }
}

/** `localTools` could not register a Toolkit's Tools with its handlers. */
export class ToolRegistrationError extends Schema.TaggedError<
  ToolRegistrationError,
  { readonly brand: unique symbol }
>()("ToolRegistrationError", { detail: Schema.String }) {
  /** Description derived from `detail`. */
  override get message(): string {
    return `Tool registration rejected: ${this.detail}`;
  }
}

/** The default loop received an explicitly incomplete Model response. */
export class IncompleteStepError extends Schema.TaggedError<
  IncompleteStepError,
  { readonly brand: unique symbol }
>()("IncompleteStepError", { reason: Schema.String }) {
  /** Description derived from `reason`. */
  override get message(): string {
    return `Model response was incomplete (${this.reason})`;
  }
}
