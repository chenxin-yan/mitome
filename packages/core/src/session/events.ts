import { Effect, Schema } from "effect";
import { Response } from "effect/unstable/ai";
import type { ApprovalResolutionError } from "./errors.js";

export interface ToolExecutionDenied {
  readonly type: "execution-denied";
  readonly reason: string;
}

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
      readonly approve: () => Effect.Effect<void, ApprovalResolutionError>;
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

export const TurnEventDtoSchema = Schema.Union([
  modelOutputEventDto,
  reasoningEventDto,
  toolCallEventDto,
  toolResultEventDto,
  approvalRequiredEventDto,
  approvalResolvedEventDto,
  responseCompleteEventDto,
]);
export type TurnEventDto = typeof TurnEventDtoSchema.Type;

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
