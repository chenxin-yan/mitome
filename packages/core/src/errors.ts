import { Schema } from "effect";

/** Overlapping `Session.prompt()` while a Turn is active. */
export class SessionBusyError extends Schema.TaggedErrorClass<SessionBusyError>()(
  "SessionBusyError",
  { message: Schema.String },
) {}

/** Prompt on a Session whose scope has already closed. */
export class SessionReleasedError extends Schema.TaggedErrorClass<SessionReleasedError>()(
  "SessionReleasedError",
  { message: Schema.String },
) {}

/** A Turn reached ADR-0003's fixed model Step limit. */
export class TurnStepLimitError extends Schema.TaggedErrorClass<TurnStepLimitError>()(
  "TurnStepLimitError",
  { message: Schema.String },
) {}

/** A model, Tool, or Plugin Hook failed while completing a Turn. */
export class TurnError extends Schema.TaggedErrorClass<TurnError>()("TurnError", {
  message: Schema.String,
  cause: Schema.Unknown,
}) {}

export class ApprovalResolutionError extends Schema.TaggedErrorClass<ApprovalResolutionError>()(
  "ApprovalResolutionError",
  { message: Schema.String },
) {}
