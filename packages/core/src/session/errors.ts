import { Effect, Schema } from "effect";
import { AiError } from "effect/unstable/ai";

const coreModuleName = "@mitome/core";

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

/** A model, Tool, or Plugin Hook failed while completing a Turn. */
export class TurnError extends Schema.TaggedErrorClass<TurnError>()("TurnError", {
  message: Schema.String,
  cause: Schema.Unknown,
}) {}

export class ApprovalResolutionError extends Schema.TaggedErrorClass<ApprovalResolutionError>()(
  "ApprovalResolutionError",
  { message: Schema.String },
) {}

export const hookTurnError = (message: string) =>
  Effect.mapError((cause: unknown) => new TurnError({ message, cause }));

export const modelTurnError = (cause: unknown) =>
  new TurnError({
    message:
      AiError.isAiError(cause) && cause.module === coreModuleName
        ? cause.reason.message
        : "Turn failed",
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
