import type { Json, TurnEvent, TurnEventDto } from "@mitome/core";
import { Schema } from "effect";

/**
 * One Turn event as it crosses the wire: the serializable `TurnEventDto` shape without the
 * persisted-only `approval-resolved`, plus `error` for a Turn that failed after the stream started.
 * Tool `params` and `result` values that are not JSON arrive as `null`. Public Turn events drop
 * the encoded Tool result, so this mapping is written by hand rather than reusing Core's DTO
 * converter.
 */
export type WireTurnEvent =
  | Exclude<TurnEventDto, { readonly type: "approval-resolved" }>
  | { readonly type: "error"; readonly message: string };

/** The JSON `data` of every SSE frame `http()` writes. */
export interface TurnFrame {
  /** Envelope version. */
  readonly v: 1;
  /** The Turn this frame belongs to, minted per request; Approval decisions name it. */
  readonly turnId: string;
  readonly event: WireTurnEvent;
}

const isJson = Schema.is(Schema.Json);
// Mirrors Core's DTO rule: values that are not JSON become null rather than failing the frame.
const jsonOrNull = (value: typeof Schema.Unknown.Type): Json => (isJson(value) ? value : null);

export const toWireEvent = (event: TurnEvent): WireTurnEvent => {
  switch (event.type) {
    case "tool-call":
      return { type: event.type, id: event.id, name: event.name, params: jsonOrNull(event.params) };
    case "tool-result":
      return {
        type: event.type,
        id: event.id,
        name: event.name,
        result: jsonOrNull(event.result),
        isFailure: event.isFailure,
      };
    case "approval-required":
      return {
        type: event.type,
        approvalId: event.approvalId,
        toolCallId: event.toolCallId,
        name: event.name,
        params: jsonOrNull(event.params),
        requirement: event.requirement,
      };
    case "model-output":
    case "reasoning":
    case "response-complete":
      return event;
  }
};

export const encodeFrame = (frame: TurnFrame): string =>
  `event: ${frame.event.type}\ndata: ${JSON.stringify(frame)}\n\n`;
