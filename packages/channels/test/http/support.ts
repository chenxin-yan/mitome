import { Schema } from "effect";
import type { TurnFrame } from "../../src/http/index.js";

export const turnRequest = (
  conversation: string,
  token: string,
  body: string = JSON.stringify({ message: "hello" }),
  init: RequestInit = {},
): Request =>
  new Request(`http://channel.test/conversations/${conversation}/turns`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body,
    ...init,
  });

export const decisionRequest = (
  turnId: string,
  approvalId: string,
  token: string,
  decision: "approve" | "deny",
  reason?: string,
): Request =>
  new Request(`http://channel.test/turns/${turnId}/approvals/${approvalId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(reason === undefined ? { decision } : { decision, reason }),
  });

const FrameSchema = Schema.fromJsonString(
  Schema.Struct({
    v: Schema.Literal(1),
    turnId: Schema.String,
    event: Schema.StructWithRest(Schema.Struct({ type: Schema.String }), [
      Schema.Record(Schema.String, Schema.Unknown),
    ]),
  }),
);
const decodeFrame = Schema.decodeUnknownSync(FrameSchema);

const parseFrame = (raw: string): TurnFrame => {
  const lines = raw.split("\n");
  const eventLine = lines.find((line) => line.startsWith("event: "));
  const dataLine = lines.find((line) => line.startsWith("data: "));
  if (eventLine === undefined || dataLine === undefined) throw new Error(`Bad frame: ${raw}`);
  const frame = decodeFrame(dataLine.slice("data: ".length));
  if (eventLine.slice("event: ".length) !== frame.event.type) {
    throw new Error(`event line disagrees with data: ${raw}`);
  }
  // SAFETY: the test asserts the exact event shapes; the decoder only checked the envelope.
  return frame as TurnFrame;
};

/** Reads SSE frames one at a time so a test can act while the Turn is paused. */
export const frameReader = (response: Response) => {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const queue: Array<TurnFrame> = [];
  let done = false;
  const next = async (): Promise<TurnFrame | undefined> => {
    while (queue.length === 0 && !done) {
      const chunk = await reader.read();
      if (chunk.done) {
        done = true;
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      queue.push(...parts.map(parseFrame));
    }
    return queue.shift();
  };
  const until = async (type: string): Promise<TurnFrame> => {
    for (;;) {
      const frame = await next();
      if (frame === undefined) throw new Error(`Stream ended before a "${type}" frame`);
      if (frame.event.type === type) return frame;
    }
  };
  const rest = async (): Promise<Array<TurnFrame>> => {
    const frames: Array<TurnFrame> = [];
    for (let frame = await next(); frame !== undefined; frame = await next()) frames.push(frame);
    return frames;
  };
  return { next, until, rest, cancel: () => reader.cancel() };
};

export const readFrames = (response: Response): Promise<Array<TurnFrame>> =>
  frameReader(response).rest();
