import { Effect, Schema } from "effect";
import { Response } from "effect/unstable/ai";
import type { ApprovalResolutionError } from "./errors.js";

/** A JSON-serializable value. */
export type Json =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<Json>
  | { readonly [key: string]: Json };

/** The Tool result the Model receives when a `preTool` Hook vetoes or a Host denies a Tool call. */
export interface ToolExecutionDenied {
  readonly type: "execution-denied";
  readonly reason: string;
}

/**
 * One event emitted while a Turn runs. `approval-required` pauses the Turn until `approve` or
 * `deny` resolves; `response-complete` is the final event of a successful Turn and is emitted only
 * after the Transcript save succeeded.
 */
export type TurnEvent =
  | { readonly type: "model-output"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | {
      readonly type: "tool-call";
      readonly id: string;
      readonly name: string;
      readonly params: unknown;
    }
  | {
      readonly type: "tool-result";
      readonly id: string;
      readonly name: string;
      readonly result: unknown;
      readonly isFailure: boolean;
    }
  | {
      readonly type: "approval-required";
      readonly approvalId: string;
      readonly toolCallId: string;
      readonly name: string;
      readonly params: unknown;
      /** Lets the Tool call run. One-shot: resolving again or after the Turn ended fails. */
      readonly approve: () => Effect.Effect<void, ApprovalResolutionError>;
      /** Rejects the Tool call; the Model sees `reason`. One-shot like `approve`. */
      readonly deny: (reason?: string) => Effect.Effect<void, ApprovalResolutionError>;
    }
  | {
      readonly type: "response-complete";
      readonly finishReason?: Response.FinishReason | undefined;
      readonly usage?: Response.Usage | undefined;
    };

export interface ApprovalResolvedEvent {
  readonly type: "approval-resolved";
  readonly approvalId: string;
  readonly toolCallId: string;
  readonly approved: boolean;
  readonly reason?: string | undefined;
}

type ToolResultEvent = Extract<TurnEvent, { readonly type: "tool-result" }>;

export type PersistedTurnEvent =
  | Exclude<TurnEvent, ToolResultEvent>
  | (ToolResultEvent & { readonly encodedResult: unknown })
  | ApprovalResolvedEvent;

const modelOutputEventDto = Schema.Struct({
  type: Schema.Literal("model-output"),
  text: Schema.String,
});
const reasoningEventDto = Schema.Struct({
  type: Schema.Literal("reasoning"),
  text: Schema.String,
});
const toolCallEventDto = Schema.Struct({
  type: Schema.Literal("tool-call"),
  id: Schema.String,
  name: Schema.String,
  params: Schema.Json,
});
const toolResultEventDto = Schema.Struct({
  type: Schema.Literal("tool-result"),
  id: Schema.String,
  name: Schema.String,
  result: Schema.Json,
  isFailure: Schema.Boolean,
});
const approvalRequiredEventDto = Schema.Struct({
  type: Schema.Literal("approval-required"),
  approvalId: Schema.String,
  toolCallId: Schema.String,
  name: Schema.String,
  params: Schema.Json,
});
const approvalResolvedEventDto = Schema.Struct({
  type: Schema.Literal("approval-resolved"),
  approvalId: Schema.String,
  toolCallId: Schema.String,
  approved: Schema.Boolean,
  reason: Schema.optional(Schema.String),
});
const responseCompleteEventDto = Schema.Struct({
  type: Schema.Literal("response-complete"),
  finishReason: Schema.optional(Response.FinishReason),
  usage: Schema.optional(Response.Usage),
});

/** Schema of the serializable Turn event persisted through `TranscriptStore.appendEvent`. */
export const TurnEventDtoSchema = Schema.Union([
  modelOutputEventDto,
  reasoningEventDto,
  toolCallEventDto,
  toolResultEventDto,
  approvalRequiredEventDto,
  approvalResolvedEventDto,
  responseCompleteEventDto,
]);
/**
 * Serializable form of a Turn event. Approval callbacks are dropped, `approval-resolved` records
 * each decision, and Tool params or results that are not JSON become `null`.
 */
export type TurnEventDto =
  | { readonly type: "model-output"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | {
      readonly type: "tool-call";
      readonly id: string;
      readonly name: string;
      readonly params: Json;
    }
  | {
      readonly type: "tool-result";
      readonly id: string;
      readonly name: string;
      readonly result: Json;
      readonly isFailure: boolean;
    }
  | {
      readonly type: "approval-required";
      readonly approvalId: string;
      readonly toolCallId: string;
      readonly name: string;
      readonly params: Json;
    }
  | {
      readonly type: "approval-resolved";
      readonly approvalId: string;
      readonly toolCallId: string;
      readonly approved: boolean;
      readonly reason?: string | undefined;
    }
  | {
      readonly type: "response-complete";
      readonly finishReason?:
        | "stop"
        | "length"
        | "content-filter"
        | "tool-calls"
        | "error"
        | "pause"
        | "other"
        | "unknown"
        | undefined;
      readonly usage?:
        | {
            readonly inputTokens: {
              readonly uncached?: number | undefined;
              readonly total?: number | undefined;
              readonly cacheRead?: number | undefined;
              readonly cacheWrite?: number | undefined;
            };
            readonly outputTokens: {
              readonly total?: number | undefined;
              readonly text?: number | undefined;
              readonly reasoning?: number | undefined;
            };
          }
        | undefined;
    };

export const turnEventToDto = (event: PersistedTurnEvent): TurnEventDto => {
  // Event records are write-only observability data, so unsupported values become null; makeTranscript fails loud for durable history.
  if (event.type === "tool-call") {
    return { ...event, params: Schema.is(Schema.Json)(event.params) ? event.params : null };
  }
  if (event.type === "tool-result") {
    return {
      type: event.type,
      id: event.id,
      name: event.name,
      result: Schema.is(Schema.Json)(event.encodedResult) ? event.encodedResult : null,
      isFailure: event.isFailure,
    };
  }
  if (event.type === "approval-required") {
    return {
      type: event.type,
      approvalId: event.approvalId,
      toolCallId: event.toolCallId,
      name: event.name,
      params: Schema.is(Schema.Json)(event.params) ? event.params : null,
    };
  }
  return event;
};
