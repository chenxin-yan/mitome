import { Effect, Stream } from "effect";
import { AiError, Response, Tool } from "effect/unstable/ai";
import { Sse } from "effect/unstable/encoding";
import { invalidOutput, providerError } from "./request.js";

type Call = { readonly id: string; readonly name: string; arguments: string };
type StreamState = {
  readonly events: Array<string>;
  readonly parser: Sse.Parser;
  readonly calls: Map<string, Call>;
  readonly textIds: Set<string>;
  terminal: boolean;
};

const string = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
// The backend keys some events by item_id ("msg_…") and omits it on others
// (output_item.added carries only output_index), so output_index is the one
// key present on every per-item event — matching Pi's reference transport.
const itemKey = (event: Record<string, unknown>) =>
  typeof event.output_index === "number"
    ? String(event.output_index)
    : (string(event.item_id) ?? "output");

const decodeEvent = (state: StreamState, data: string): Array<Response.StreamPartEncoded> => {
  if (data === "[DONE]") return [];
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(data) as Record<string, unknown>;
  } catch {
    throw invalidOutput("Codex sent malformed SSE JSON");
  }
  const type = string(event.type);
  if (type === "error") {
    const error = record(event.error);
    throw providerError(string(error?.message) ?? string(event.message) ?? "Codex provider error");
  }
  if (type === "response.failed") {
    const response = record(event.response);
    const error = record(response?.error);
    throw providerError(string(error?.message) ?? "Codex response failed");
  }
  if (type === "response.done" || type === "response.completed" || type === "response.incomplete") {
    state.terminal = true;
    return [];
  }
  const key = itemKey(event);
  if (type === "response.output_item.added") {
    const item = record(event.item);
    if (item?.type === "message") {
      state.textIds.add(key);
      return [Response.makePart("text-start", { id: key })];
    }
    if (item?.type === "function_call") {
      const id = string(item.call_id) ?? string(item.id);
      const name = string(item.name);
      if (id === undefined || name === undefined)
        throw invalidOutput("Codex sent an incomplete Tool call");
      const call = { id, name, arguments: "" };
      state.calls.set(key, call);
      // Argument deltas may arrive keyed by item_id instead of output_index.
      const itemId = string(item.id);
      if (itemId !== undefined) state.calls.set(itemId, call);
      return [Response.makePart("tool-params-start", { id, name, providerExecuted: false })];
    }
    return [];
  }
  if (type === "response.output_text.delta") {
    const delta = string(event.delta);
    if (delta === undefined || !state.textIds.has(key))
      throw invalidOutput("Codex sent text without a message item");
    return [Response.makePart("text-delta", { id: key, delta })];
  }
  if (type === "response.function_call_arguments.delta") {
    const call = state.calls.get(key);
    const delta = string(event.delta);
    if (call === undefined || delta === undefined)
      throw invalidOutput("Codex sent arguments without a Tool call");
    call.arguments += delta;
    return [Response.makePart("tool-params-delta", { id: call.id, delta })];
  }
  if (type === "response.function_call_arguments.done") {
    const call = state.calls.get(key);
    const arguments_ = string(event.arguments);
    if (call === undefined || arguments_ === undefined)
      throw invalidOutput("Codex sent final arguments without a Tool call");
    const delta = arguments_.startsWith(call.arguments)
      ? arguments_.slice(call.arguments.length)
      : "";
    call.arguments = arguments_;
    return delta === "" ? [] : [Response.makePart("tool-params-delta", { id: call.id, delta })];
  }
  if (type === "response.output_item.done") {
    const item = record(event.item);
    if (item?.type === "message")
      return state.textIds.delete(key) ? [Response.makePart("text-end", { id: key })] : [];
    if (item?.type === "function_call") {
      const call = state.calls.get(key) ?? state.calls.get(string(item.id) ?? "");
      if (call === undefined) throw invalidOutput("Codex completed an unknown Tool call");
      const arguments_ = string(item.arguments) ?? call.arguments;
      let params: unknown;
      try {
        params = Tool.unsafeSecureJsonParse(arguments_ || "{}");
      } catch {
        throw invalidOutput(`Invalid JSON arguments for Tool ${call.name}`);
      }
      state.calls.delete(key);
      return [
        Response.makePart("tool-params-end", { id: call.id }),
        Response.makePart("tool-call", {
          id: call.id,
          name: call.name,
          params,
          providerExecuted: false,
        }),
      ];
    }
  }
  return [];
};

export const decodeStream = <R>(
  stream: Stream.Stream<Uint8Array, AiError.AiError, R>,
): Stream.Stream<Response.StreamPartEncoded, AiError.AiError, R> =>
  // Suspend so a re-run (e.g. a future retry) gets fresh parser/terminal state.
  Stream.suspend(() => {
    const events: Array<string> = [];
    const state: StreamState = {
      events,
      parser: Sse.makeParser((event) => {
        if (event._tag === "Event") events.push(event.data);
      }),
      calls: new Map(),
      textIds: new Set(),
      terminal: false,
    };
    return stream.pipe(
      Stream.decodeText,
      Stream.mapAccumArrayEffect(
        () => state,
        (current, chunk) =>
          Effect.try({
            try: () => {
              for (const value of chunk) current.parser.feed(value);
              return [
                current,
                current.events.splice(0).flatMap((event) => decodeEvent(current, event)),
              ] as const;
            },
            catch: (cause) =>
              AiError.isAiError(cause) ? cause : invalidOutput("Codex stream failed"),
          }),
      ),
      Stream.concat(
        Stream.fromEffect(
          Effect.suspend(() =>
            state.terminal
              ? Effect.void
              : Effect.fail(invalidOutput("Codex stream ended before a terminal response event")),
          ),
        ).pipe(Stream.drain),
      ),
    );
  });
