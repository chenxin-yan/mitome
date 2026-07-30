import { Effect, Result, Schema, Stream } from "effect";
import { AiError, Response, Tool } from "effect/unstable/ai";
import { Sse } from "effect/unstable/encoding";
import { invalidOutput, providerError } from "./request.js";

type Call = { readonly id: string; readonly name: string; arguments: string };
type StreamState = {
  readonly parser: Sse.Parser;
  readonly calls: Map<string, Call>;
  readonly textIds: Set<string>;
  terminal: boolean;
};

const Event = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const ErrorEvent = Schema.Struct({
  error: Schema.optional(Schema.Struct({ message: Schema.optional(Schema.String) })),
  message: Schema.optional(Schema.String),
});
const FailedEvent = Schema.Struct({
  response: Schema.optional(
    Schema.Struct({
      error: Schema.optional(Schema.Struct({ message: Schema.optional(Schema.String) })),
    }),
  ),
});
const ItemType = Schema.Struct({ type: Schema.String });
const FunctionCallAddedItem = Schema.Struct({
  call_id: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  name: Schema.String,
});
const FunctionCallDoneItem = Schema.Struct({
  id: Schema.optional(Schema.String),
  arguments: Schema.optional(Schema.String),
});
const ReasoningItem = Schema.Struct({
  id: Schema.String,
  encrypted_content: Schema.optional(Schema.NullOr(Schema.String)),
  summary: Schema.Array(
    Schema.Struct({ type: Schema.Literal("summary_text"), text: Schema.String }),
  ),
});
const Delta = Schema.Struct({ delta: Schema.String });
const FinalArguments = Schema.Struct({ arguments: Schema.String });

const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
  onFailure: () => unknown,
) => {
  const result = Schema.decodeUnknownResult(schema)(input);
  if (Result.isFailure(result)) throw onFailure();
  return result.success;
};

// The backend keys some events by item_id ("msg_…") and omits it on others
// (output_item.added carries only output_index), so output_index is the one
// key present on every per-item event — matching Pi's reference transport.
const itemKey = (event: Record<string, unknown>) =>
  typeof event.output_index === "number"
    ? String(event.output_index)
    : typeof event.item_id === "string"
      ? event.item_id
      : "output";

// Item type drives dispatch only; unknown/malformed items are ignored.
const outputItemType = (item: unknown): string | undefined => {
  const result = Schema.decodeUnknownResult(ItemType)(item);
  return Result.isFailure(result) ? undefined : result.success.type;
};

const decodeOutputItemAdded = (
  state: StreamState,
  item: unknown,
  key: string,
): Array<Response.StreamPartEncoded> => {
  const itemType = outputItemType(item);
  if (itemType === "message") {
    state.textIds.add(key);
    return [Response.makePart("text-start", { id: key })];
  }
  if (itemType === "function_call") {
    const added = decode(FunctionCallAddedItem, item, () =>
      invalidOutput("Codex sent an incomplete Tool call"),
    );
    const id = added.call_id ?? added.id;
    if (id === undefined) throw invalidOutput("Codex sent an incomplete Tool call");
    const call = { id, name: added.name, arguments: "" };
    state.calls.set(key, call);
    // Argument deltas may arrive keyed by item_id instead of output_index.
    if (added.id !== undefined) state.calls.set(added.id, call);
    return [
      Response.makePart("tool-params-start", { id, name: added.name, providerExecuted: false }),
    ];
  }
  return [];
};

const decodeOutputItemDone = (
  state: StreamState,
  item: unknown,
  key: string,
): Array<Response.StreamPartEncoded> => {
  const itemType = outputItemType(item);
  if (itemType === "message") {
    return state.textIds.delete(key) ? [Response.makePart("text-end", { id: key })] : [];
  }
  if (itemType === "reasoning") {
    const reasoning = decode(ReasoningItem, item, () =>
      invalidOutput("Codex sent incomplete reasoning"),
    );
    const id = `${reasoning.id}:0`;
    const text = reasoning.summary.map(({ text }) => text).join("\n");
    const metadata = {
      openai: {
        itemId: reasoning.id,
        ...(reasoning.encrypted_content == null
          ? {}
          : { encryptedContent: reasoning.encrypted_content }),
      },
    };
    return [
      Response.makePart("reasoning-start", { id, metadata }),
      ...(text === "" ? [] : [Response.makePart("reasoning-delta", { id, delta: text })]),
      Response.makePart("reasoning-end", { id, metadata }),
    ];
  }
  if (itemType === "function_call") {
    const done = decode(FunctionCallDoneItem, item, () =>
      invalidOutput("Codex completed an unknown Tool call"),
    );
    const call = state.calls.get(key) ?? state.calls.get(done.id ?? "");
    if (call === undefined) throw invalidOutput("Codex completed an unknown Tool call");
    const arguments_ = done.arguments ?? call.arguments;
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
  return [];
};

const decodeEvent = (state: StreamState, data: string): Array<Response.StreamPartEncoded> => {
  if (data === "[DONE]") return [];
  const event = decode(Event, data, () => invalidOutput("Codex sent malformed SSE JSON"));
  const type = typeof event.type === "string" ? event.type : undefined;
  if (type === "error") {
    const decoded = decode(ErrorEvent, event, () => providerError("Codex provider error"));
    throw providerError(decoded.error?.message ?? decoded.message ?? "Codex provider error");
  }
  if (type === "response.failed") {
    const decoded = decode(FailedEvent, event, () => providerError("Codex response failed"));
    throw providerError(decoded.response?.error?.message ?? "Codex response failed");
  }
  if (type === "response.done" || type === "response.completed" || type === "response.incomplete") {
    state.terminal = true;
    return [];
  }
  const key = itemKey(event);
  if (type === "response.output_item.added") {
    return decodeOutputItemAdded(state, event.item, key);
  }
  if (type === "response.output_text.delta") {
    const decoded = decode(Delta, event, () =>
      invalidOutput("Codex sent text without a message item"),
    );
    if (!state.textIds.has(key)) throw invalidOutput("Codex sent text without a message item");
    return [Response.makePart("text-delta", { id: key, delta: decoded.delta })];
  }
  if (type === "response.function_call_arguments.delta") {
    const decoded = decode(Delta, event, () =>
      invalidOutput("Codex sent arguments without a Tool call"),
    );
    const call = state.calls.get(key);
    if (call === undefined) throw invalidOutput("Codex sent arguments without a Tool call");
    call.arguments += decoded.delta;
    return [Response.makePart("tool-params-delta", { id: call.id, delta: decoded.delta })];
  }
  if (type === "response.function_call_arguments.done") {
    const decoded = decode(FinalArguments, event, () =>
      invalidOutput("Codex sent final arguments without a Tool call"),
    );
    const call = state.calls.get(key);
    if (call === undefined) throw invalidOutput("Codex sent final arguments without a Tool call");
    const arguments_ = decoded.arguments;
    const delta = arguments_.startsWith(call.arguments)
      ? arguments_.slice(call.arguments.length)
      : "";
    call.arguments = arguments_;
    return delta === "" ? [] : [Response.makePart("tool-params-delta", { id: call.id, delta })];
  }
  if (type === "response.output_item.done") {
    return decodeOutputItemDone(state, event.item, key);
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
                events.splice(0).flatMap((event) => decodeEvent(current, event)),
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
