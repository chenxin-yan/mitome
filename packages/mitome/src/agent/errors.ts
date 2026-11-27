import { Match, Predicate, Schema } from "effect";

/** A Session was asked to run a Command none of its Extensions names. */
export class CommandNotFoundError extends Schema.TaggedError<
  CommandNotFoundError,
  { readonly brand: unique symbol }
>()("CommandNotFoundError", { command: Schema.String }) {
  /** Description derived from `command`. */
  override get message(): string {
    return `There is no command /${this.command}`;
  }
}

/** A Command's `run` failed; `cause` is its failure. */
export class CommandFailedError extends Schema.TaggedError<
  CommandFailedError,
  { readonly brand: unique symbol }
>()("CommandFailedError", { command: Schema.String, cause: Schema.Unknown }) {
  /** Description derived from `command`, followed by the cause's when it has one. */
  override get message(): string {
    const why = this.cause instanceof Error ? this.cause.message : this.cause;
    const failed = `Command /${this.command} failed`;
    return Predicate.isString(why) && why !== "" ? `${failed}: ${why}` : failed;
  }
}

/** Work offered to an acquired Configuration after its shutdown started. */
export class MitomeClosedError extends Schema.TaggedError<
  MitomeClosedError,
  { readonly brand: unique symbol }
>()("MitomeClosedError", {}) {
  /** Fixed description; the error carries no fields. */
  override get message(): string {
    return "Mitome instance is shutting down and admits no new work";
  }
}

/** No Model could be selected or provisioned for a Configuration's acquisition. */
export class ModelSelectionError extends Schema.TaggedError<
  ModelSelectionError,
  { readonly brand: unique symbol }
>()("ModelSelectionError", { detail: Schema.String }) {
  /** Description derived from `detail`. */
  override get message(): string {
    return `Model selection failed: ${this.detail}`;
  }
}

/** The identity text mapping met a result that is not a string; the Agent needs its own `text`. */
export class TextMappingError extends Schema.TaggedError<
  TextMappingError,
  { readonly brand: unique symbol }
>()("TextMappingError", {
  detail: Schema.String,
}) {
  /** Description derived from `detail`. */
  override get message(): string {
    return `Text mapping failed: ${this.detail}`;
  }
}

/**
 * A Host asked for a stored conversation that cannot be had: nothing provides `Transcripts`
 * (`no-store`), or it has no such conversation (`not-found`).
 */
export class TranscriptSelectionError extends Schema.TaggedError<
  TranscriptSelectionError,
  { readonly brand: unique symbol }
>()("TranscriptSelectionError", {
  reason: Schema.Literals(["no-store", "not-found"]),
}) {
  /** Description derived from `reason`. */
  override get message(): string {
    return Match.value(this.reason).pipe(
      Match.when("no-store", () => "No conversation can be continued: none are kept"),
      Match.when("not-found", () => "No conversation to continue was found"),
      Match.exhaustive,
    );
  }
}
