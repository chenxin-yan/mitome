import { Schema } from "effect";

/** `Session.run` while another Turn of the same Session is active, including a nested call. */
export class SessionBusyError extends Schema.TaggedError<SessionBusyError>()(
  "SessionBusyError",
  {},
) {
  /** Fixed description; the error carries no fields. */
  override get message(): string {
    return "Session is busy with an active Turn";
  }
}

/** Use of a Session whose allocating Scope has closed or is closing. */
export class SessionReleasedError extends Schema.TaggedError<SessionReleasedError>()(
  "SessionReleasedError",
  {},
) {
  /** Fixed description; the error carries no fields. */
  override get message(): string {
    return "Session scope has been released";
  }
}

/**
 * A Turn's save outcome is unknown, so the Session rejects further Turns rather than assume
 * nothing was written. Only reconciliation can settle it; this Session cannot.
 */
export class SessionFencedError extends Schema.TaggedError<SessionFencedError>()(
  "SessionFencedError",
  {},
) {
  /** Fixed description; the error carries no fields. */
  override get message(): string {
    return "Session is fenced by a Turn whose save outcome is unknown";
  }
}

/**
 * A `SessionStore` save failed. `not-written` asserts nothing was saved, so committed history is
 * unchanged and the Session stays usable; `unknown` makes no such claim and fences the Session.
 */
export class SessionSaveError extends Schema.TaggedError<SessionSaveError>()("SessionSaveError", {
  outcome: Schema.Literals(["not-written", "unknown"]),
}) {
  /** Description derived from `outcome`. */
  override get message(): string {
    return this.outcome === "not-written"
      ? "Session save failed without writing"
      : "Session save outcome is unknown";
  }
}

/**
 * A controlled Step would exceed its root Turn's `ExecutionLimits`. Nothing was dispatched for the
 * refused unit; work already reserved stays counted.
 */
export class ExecutionLimitError extends Schema.TaggedError<ExecutionLimitError>()(
  "ExecutionLimitError",
  { limit: Schema.Literals(["generations", "dispatches"]), bound: Schema.Finite },
) {
  /** Description derived from `limit` and `bound`. */
  override get message(): string {
    return `Turn reached its limit of ${this.bound} ${this.limit === "generations" ? "Model generations" : "local Tool dispatches"}`;
  }
}

/**
 * A controlled Step refused to proceed before any local Tool ran: the Model binding's physical
 * requests are not accounted for (`unsupported-accounting`, before any request), the Prompt
 * carried native approval artifacts (`approval-artifact`, before any request), the response was
 * malformed or contradictory (`malformed-response`), or it asked for a continuation Mitome does
 * not support (`unsupported-continuation`).
 */
export class StepProtocolError extends Schema.TaggedError<StepProtocolError>()(
  "StepProtocolError",
  {
    reason: Schema.Literals([
      "unsupported-accounting",
      "approval-artifact",
      "malformed-response",
      "unsupported-continuation",
    ]),
    detail: Schema.String,
  },
) {
  /** Description derived from `reason` and `detail`. */
  override get message(): string {
    return `Controlled Step rejected (${this.reason}): ${this.detail}`;
  }
}

/** `localTools` could not register a Toolkit's Tools with its handlers. */
export class ToolRegistrationError extends Schema.TaggedError<ToolRegistrationError>()(
  "ToolRegistrationError",
  { detail: Schema.String },
) {
  /** Description derived from `detail`. */
  override get message(): string {
    return `Tool registration rejected: ${this.detail}`;
  }
}

/** The default loop received an explicitly incomplete Model response. */
export class IncompleteStepError extends Schema.TaggedError<IncompleteStepError>()(
  "IncompleteStepError",
  { reason: Schema.String },
) {
  /** Description derived from `reason`. */
  override get message(): string {
    return `Model response was incomplete (${this.reason})`;
  }
}
