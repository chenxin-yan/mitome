import { Effect, Schema } from "effect";
import { AiError } from "effect/unstable/ai";

const coreModuleName = "@mitome/core";

/** Overlapping `Session.prompt()` while a Turn is active. */
export class SessionBusyError extends Schema.TaggedError<SessionBusyError>()(
  "SessionBusyError",
  {},
) {
  override get message(): string {
    return "Session is busy with an active Turn";
  }
}

/** Prompt on a Session whose scope has already closed. */
export class SessionReleasedError extends Schema.TaggedError<SessionReleasedError>()(
  "SessionReleasedError",
  {},
) {
  override get message(): string {
    return "Session scope has been released";
  }
}

/** A model, Tool, or Extension Hook failed while completing a Turn. */
export class TurnError extends Schema.TaggedError<TurnError>()("TurnError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export class ApprovalResolutionError extends Schema.TaggedError<ApprovalResolutionError>()(
  "ApprovalResolutionError",
  { reason: Schema.optional(Schema.Literal("not-pending")) },
) {
  override get message(): string {
    return this.reason === "not-pending"
      ? "Approval is no longer pending (the Turn ended or the request is missing)"
      : "Approval decision has already been resolved";
  }
}

export const hookTurnError = (message: string) =>
  Effect.mapError((cause: unknown) => new TurnError({ message, cause }));

export const modelTurnError = (cause: unknown) =>
  new TurnError({
    message: AiError.isAiError(cause) ? cause.reason.message : "Turn failed",
    cause,
  });

const describeFailure = (message: string, cause: unknown): string =>
  `${message}: ${cause instanceof Error ? cause.message : String(cause)}`;

export const hookAiError = (method: string, message: string) =>
  Effect.mapError((cause: unknown) => {
    const reason = AiError.isAiError(cause)
      ? cause.reason
      : AiError.isAiErrorReason(cause)
        ? cause
        : new AiError.UnknownError({ description: describeFailure(message, cause) });
    return AiError.make({ module: coreModuleName, method, reason });
  });

export const toolAiError = (method: string) =>
  Effect.mapError((cause: unknown) =>
    AiError.isAiError(cause)
      ? cause
      : AiError.make({
          module: coreModuleName,
          method,
          reason: AiError.isAiErrorReason(cause)
            ? cause
            : new AiError.UnknownError({
                description: describeFailure("Tool execution failed", cause),
              }),
        }),
  );
