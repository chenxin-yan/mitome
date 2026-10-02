import { Effect, Equal, Predicate, Result, Schema, Stream } from "effect";
import { AiError, Response, Tool } from "effect/ai";
import { Sse } from "effect/encoding";
import { invalidOutput, providerError } from "./request.js";

/**
 * One indexed part of an item streamed by sub-events: a message content part (`content_index`),
 * a reasoning summary part (`summary_index`) or reasoning text (`content_index`).
 */
type Slot = {
  readonly type: "text" | "refusal";
  value: string;
  /** The part's value as its done event (or `content_part.done`) finalized it. */
  final: string | undefined;
  /**
   * Whether a value was supplied (a snapshot, delta, non-empty part start or done event); a part
   * that is only declared has none yet, which is not an empty value.
   */
  known: boolean;
  /** Whether its text part was started on the stream. */
  started: boolean;
  /**
   * Whether its value is only a supplied snapshot's (an item start's content or summary, or an
   * Incomplete listing's) that no event of the part confirmed: an indexed delta appends to it,
   * while a part event's non-empty value, a done event's value or a locator-less event's text
   * replaces it unchecked.
   */
  seeded: boolean;
  /**
   * Whether a stream event named the part (by its index, or as the one part a locator-less event
   * names), whatever supplied its value: a locator-less event names the item's only declared part,
   * and a finished item must hold every declared part. A part only a snapshot supplied is not.
   */
  declared: boolean;
};

/** One output item's lifecycle, found by its output index or item id (separate namespaces). */
type Item = {
  readonly kind: "message" | "reasoning" | "function_call";
  /**
   * Id of the stream parts this item emits: its output index, else a sequence id (`#n`) that no
   * output index or other item can take.
   */
  readonly partId: string;
  itemId: string | undefined;
  readonly callId: string | undefined;
  readonly name: string | undefined;
  arguments: string;
  /**
   * The arguments a `function_call_arguments.done` event finalized, if any; for a call finished
   * with an explicit non-completed status, those it supplied (its done item's, else the finalized).
   */
  finalArguments: string | undefined;
  /** Message text emitted so far (deltas, or the done item's content). */
  text: string;
  /** The done item's supplied content, in order, if it supplied any. */
  content: ReadonlyArray<ContentPart> | undefined;
  /** Whether locator-less-indexed (no `content_index`) text deltas streamed its one text part. */
  sawDelta: boolean;
  /** Message content parts by `content_index`, seeded by the start's content. */
  readonly slots: Map<number, Slot>;
  /** Reasoning summary parts by `summary_index`, seeded by the start's summary. */
  readonly summaries: Map<number, Slot>;
  /** Reasoning text parts streamed by `content_index`. */
  readonly reasoningTexts: Map<number, Slot>;
  done: boolean;
  /** Finished with an explicit non-completed status. */
  unfinished: boolean;
  params: Json | undefined;
  summary: string | undefined;
  /** The finished reasoning item's private `reasoning_text` content, reconciled but not shown. */
  reasoningContent: ReadonlyArray<string> | undefined;
  encryptedContent: string | null | undefined;
};
type StreamState = {
  readonly parser: Sse.Parser;
  readonly items: Array<Item>;
  readonly byIndex: Map<string, Item>;
  readonly byItemId: Map<string, Item>;
  /**
   * Items finished since the first one finished with a non-completed status, in done order, with
   * the final parts of those completed (an unfinished one is shown at the incomplete terminal).
   */
  readonly deferred: Array<{
    readonly item: Item;
    readonly parts: ReadonlyArray<Response.StreamPartEncoded> | undefined;
  }>;
  terminal: boolean;
};

type Json = typeof Schema.Json.Type;
type JsonInput = Json | undefined;
const Event = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));
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
// The Responses API requires `call_id`, the correlation a Tool result answers; the item `id` is
// optional and only an alias for events keyed by item.
const FunctionCallAddedItem = Schema.Struct({
  call_id: Schema.String,
  id: Schema.optional(Schema.String),
  name: Schema.String,
  arguments: Schema.optional(Schema.String),
});
const FullCall = Schema.Struct({
  call_id: Schema.String,
  name: Schema.String,
  arguments: Schema.String,
});
const FunctionCallDoneItem = Schema.Struct({
  id: Schema.optional(Schema.String),
  call_id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  arguments: Schema.optional(Schema.String),
});
// The Responses item statuses; absent is sparse, any other value is malformed.
const ItemStatus = Schema.Struct({
  status: Schema.optional(Schema.Literals(["completed", "in_progress", "incomplete"])),
});
// A reasoning summary part: the Responses API and the Codex CLI both require `summary_text`.
const SummaryText = Schema.Struct({ type: Schema.Literal("summary_text"), text: Schema.String });
const ReasoningText = Schema.Struct({
  type: Schema.Literal("reasoning_text"),
  text: Schema.String,
});
// A reasoning start's own snapshot (the Codex CLI's `ev_reasoning_item_added` sends a summary).
const ReasoningStart = Schema.Struct({
  summary: Schema.optional(Schema.Array(SummaryText)),
  encrypted_content: Schema.optional(Schema.NullOr(Schema.String)),
});
const ReasoningItem = Schema.Struct({
  id: Schema.String,
  content: Schema.optional(
    Schema.Array(Schema.Struct({ type: Schema.Literal("reasoning_text"), text: Schema.String })),
  ),
  encrypted_content: Schema.optional(Schema.NullOr(Schema.String)),
  summary: Schema.Array(SummaryText),
});
const Delta = Schema.Struct({ delta: Schema.String });
const FinalArguments = Schema.Struct({ arguments: Schema.String });
const TerminalEvent = Schema.Struct({
  response: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        // Any value, so a status never makes a terminal event malformed; it is checked below.
        status: Schema.optional(Schema.Unknown),
        // Absent (as in the Codex CLI's own fixtures) is not provided; null is malformed.
        output: Schema.optional(Schema.Array(Schema.Json)),
        error: Schema.optional(
          Schema.NullOr(Schema.Struct({ message: Schema.optional(Schema.String) })),
        ),
        incomplete_details: Schema.optional(
          Schema.NullOr(Schema.Struct({ reason: Schema.optional(Schema.String) })),
        ),
        usage: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              input_tokens: Schema.optional(Schema.Finite),
              output_tokens: Schema.optional(Schema.Finite),
              input_tokens_details: Schema.optional(
                Schema.NullOr(Schema.Struct({ cached_tokens: Schema.optional(Schema.Finite) })),
              ),
              output_tokens_details: Schema.optional(
                Schema.NullOr(Schema.Struct({ reasoning_tokens: Schema.optional(Schema.Finite) })),
              ),
            }),
          ),
        ),
      }),
    ),
  ),
});

const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: JsonInput | string,
  onFailure: () => AiError.AiError,
) => {
  const result = Schema.decodeUnknownResult(schema)(input);
  if (Result.isFailure(result)) throw onFailure();
  return result.success;
};

const Locators = Schema.Struct({
  output_index: Schema.optional(Schema.Finite),
  item_id: Schema.optional(Schema.String),
});
const OutputItem = Schema.Struct({ type: Schema.String, id: Schema.optional(Schema.String) });
const MessageContent = Schema.Struct({
  content: Schema.optional(Schema.Array(Schema.Json)),
});
const ContentType = Schema.Struct({ type: Schema.String });
const OutputText = Schema.Struct({ text: Schema.String });
const Refusal = Schema.Struct({ refusal: Schema.String });

const contradiction = () => invalidOutput("Codex sent output events that contradict each other");

/**
 * The output item an event is about. Every locator it supplies (event output index, event item
 * id, the payload's own id) must name the same item; a locator the item lacked is adopted.
 */
/** The output index and item ids an event supplies for its item. */
const locatorsOf = (event: Json, payloadId: string | undefined) => {
  const locators = decode(Locators, event, () => invalidOutput("Codex sent malformed item keys"));
  const index = locators.output_index === undefined ? undefined : String(locators.output_index);
  return { index, ids: [locators.item_id, payloadId].filter(Predicate.isNotUndefined) };
};

/**
 * The item an event is about. An event with no locator at all (the Codex CLI's own text delta
 * fixture) names the only open item of its kind; with none open it names no item, and with more
 * than one it is ambiguous and fails.
 */
const locate = (
  state: StreamState,
  event: Json,
  payloadId: string | undefined,
  kind?: Item["kind"],
) => {
  const { index, ids } = locatorsOf(event, payloadId);
  if (index === undefined && ids.length === 0) {
    const open = state.items.filter(
      (item) => !item.done && (kind === undefined || item.kind === kind),
    );
    if (open.length > 1)
      throw invalidOutput("Codex sent an output event that names no single item");
    return { item: open[0], index, ids };
  }
  const found = [
    index === undefined ? undefined : state.byIndex.get(index),
    ...ids.map((id) => state.byItemId.get(id)),
  ].filter(Predicate.isNotUndefined);
  const item = found[0];
  if (item === undefined) return { item, index, ids };
  if (found.some((other) => other !== item)) throw contradiction();
  if (index !== undefined && state.byIndex.get(index) !== item) throw contradiction();
  for (const id of ids) {
    if (item.itemId === undefined) {
      item.itemId = id;
      state.byItemId.set(id, item);
    } else if (item.itemId !== id) throw contradiction();
  }
  return { item, index, ids };
};

const register = (
  state: StreamState,
  kind: Item["kind"],
  index: string | undefined,
  ids: ReadonlyArray<string>,
  call?: { readonly callId: string; readonly name: string; readonly arguments: string },
): Item => {
  const itemId = ids[0];
  // Only called for locators that name no item yet (see `locate`).
  if (ids.some((id) => id !== itemId)) throw contradiction();
  // `call_id` is the correlation a Tool result answers, so it names one call only.
  if (call !== undefined && state.items.some((item) => item.callId === call.callId)) {
    throw invalidOutput("Codex reused a Tool call id");
  }
  const item: Item = {
    kind,
    partId: index ?? `#${state.items.length}`,
    itemId,
    callId: call?.callId,
    name: call?.name,
    arguments: call?.arguments ?? "",
    finalArguments: undefined,
    text: "",
    content: undefined,
    sawDelta: false,
    slots: new Map(),
    summaries: new Map(),
    reasoningTexts: new Map(),
    done: false,
    unfinished: false,
    params: undefined,
    summary: undefined,
    reasoningContent: undefined,
    encryptedContent: undefined,
  };
  state.items.push(item);
  if (index !== undefined) state.byIndex.set(index, item);
  if (itemId !== undefined) state.byItemId.set(itemId, item);
  return item;
};

/**
 * Output items that mean the Provider ran or wants to run a Tool other than the request's local
 * functions (the Responses schema's `*_call` and MCP items). A Codex request advertises only local
 * functions, so such an item contradicts it; the response fails before anything is dispatched.
 */
const isRemoteToolItem = (itemType: string) =>
  itemType !== "function_call" && (itemType.endsWith("_call") || itemType.startsWith("mcp_"));

/**
 * The kind of a generated output item. Only messages, reasoning and local function calls are
 * representable; any other generated item (a Tool output, program, compaction, unknown type or
 * malformed payload) fails the response rather than vanishing from it.
 */
type OutputItemKind = { readonly kind: Item["kind"]; readonly id: string | undefined };
const outputItemKind = (item: JsonInput): OutputItemKind => {
  const result = Schema.decodeUnknownResult(OutputItem)(item);
  if (Result.isFailure(result)) throw invalidOutput("Codex sent a malformed output item");
  const { type, id } = result.success;
  if (type === "message" || type === "reasoning" || type === "function_call")
    return { kind: type, id };
  throw invalidOutput(
    isRemoteToolItem(type)
      ? `Codex returned an unrequested Provider Tool item (${type})`
      : `Codex returned an output item this request cannot represent (${type})`,
  );
};

// An absent status is sparse metadata, not a contradiction; only an explicit other status is.
const isUnfinished = (status: JsonInput) => status !== undefined && status !== "completed";

const itemStatus = (item: JsonInput) =>
  decode(ItemStatus, item, () => invalidOutput("Codex sent a malformed output item")).status;

/** One representable message content part: `output_text` text or a `refusal` explanation. */
type ContentPart = { readonly text: string } | { readonly refusal: string };

/**
 * A message's supplied content, if it supplies any, in order. Native rc.117 represents a refusal as
 * an empty text part whose `metadata.openai.refusal` keeps the explanation, never as ordinary text;
 * any other content type cannot be represented and fails the response rather than vanishing.
 */
const messageContent = (item: JsonInput): ReadonlyArray<ContentPart> | undefined => {
  const malformed = () => invalidOutput("Codex sent a malformed message");
  const decoded = decode(MessageContent, item, malformed);
  return decoded.content?.map((part): ContentPart => {
    const { type } = decode(ContentType, part, malformed);
    if (type === "output_text") return { text: decode(OutputText, part, malformed).text };
    if (type === "refusal") return { refusal: decode(Refusal, part, malformed).refusal };
    throw invalidOutput(`Codex returned message content this request cannot represent (${type})`);
  });
};

/** Content for comparison: adjacent text joined and empty text dropped; refusals kept in place. */
const comparable = (content: ReadonlyArray<ContentPart>) => {
  const out: Array<ContentPart> = [];
  for (const part of content) {
    const last = out.at(-1);
    if (!("text" in part)) out.push(part);
    else if (part.text === "") continue;
    else if (last !== undefined && "text" in last)
      out[out.length - 1] = { text: last.text + part.text };
    else out.push(part);
  }
  return out;
};

const refusalPart = (id: string, refusal: string): Array<Response.StreamPartEncoded> => {
  // Native rc.117's own text metadata shape for a refusal, carried on the text's stream parts.
  const metadata: Response.TextPartMetadata = { openai: { refusal } };
  return [
    Response.makePart("text-start", { id, metadata }),
    Response.makePart("text-end", { id, metadata }),
  ];
};

const decodeOutputItemAdded = (
  state: StreamState,
  event: Json,
  payload: JsonInput,
): Array<Response.StreamPartEncoded> => {
  const { kind, id } = outputItemKind(payload);
  // A start's own status is validated like a done item's; the done event decides completion.
  itemStatus(payload);
  const { index, ids } = locatorsOf(event, id);
  // A start may not take over the output index or item id of an earlier item.
  if (
    (index !== undefined && state.byIndex.has(index)) ||
    ids.some((itemId) => state.byItemId.has(itemId))
  ) {
    throw invalidOutput("Codex reused an output item locator");
  }
  if (kind === "function_call") {
    const added = decode(FunctionCallAddedItem, payload, () =>
      invalidOutput("Codex sent an incomplete Tool call"),
    );
    register(state, kind, index, ids, {
      callId: added.call_id,
      name: added.name,
      arguments: added.arguments ?? "",
    });
    return [
      Response.makePart("tool-params-start", {
        id: added.call_id,
        name: added.name,
        providerExecuted: false,
      }),
    ];
  }
  // A start's nested content or summary is a snapshot (the Codex CLI's `ev_message_item_added` and
  // `ev_reasoning_item_added` send one); it must be representable and seeds the item's indexed
  // parts, which indexed deltas extend. A start alone materializes no text part.
  const startContent = kind === "message" ? messageContent(payload) : undefined;
  const item = register(state, kind, index, ids);
  mergeSnapshot(item.slots, startContent ?? []);
  if (kind === "reasoning") {
    const start = decode(ReasoningStart, payload, () =>
      invalidOutput("Codex sent incomplete reasoning"),
    );
    mergeSnapshot(item.summaries, start.summary ?? []);
    item.encryptedContent = start.encrypted_content;
  }
  return [];
};

const decodeOutputItemDone = (
  state: StreamState,
  event: Json,
  payload: JsonInput,
): Array<Response.StreamPartEncoded> => {
  const { kind, id } = outputItemKind(payload);
  const located = locateDone(state, event, payload, kind, id);
  // An item may arrive whole in its done event, as the Codex CLI's own `ev_assistant_message` and
  // `ev_function_call` fixtures send them; a done-only call must state its call id, name and
  // arguments itself.
  let wholeCall: typeof FullCall.Type | undefined;
  if (located.item === undefined && kind === "function_call") {
    wholeCall = decode(FullCall, payload, () =>
      invalidOutput("Codex completed an unknown Tool call"),
    );
  }
  const item =
    located.item ??
    register(
      state,
      kind,
      located.index,
      located.ids,
      wholeCall === undefined
        ? undefined
        : {
            callId: wholeCall.call_id,
            name: wholeCall.name,
            arguments: wholeCall.arguments,
          },
    );
  if (item.kind !== kind) throw contradiction();
  if (item.done) throw invalidOutput("Codex finished an output item twice");
  item.done = true;
  // An item that is itself not completed keeps its data, but a complete terminal then rejects
  // the response, and an unfinished call is never dispatchable.
  item.unfinished = isUnfinished(itemStatus(payload));
  // An unfinished item is not ended here: its supplied state is kept, and its parts are ended once,
  // at an incomplete terminal, after its listing is merged (a complete terminal rejects it).
  if (kind === "message") {
    const supplied = messageContent(payload);
    if (!item.sawDelta) {
      finishMessage(item, supplied);
      return finished(state, item, () => messageParts(item));
    }
    const fit = supplied === undefined ? "fits" : streamedTextFit(item, supplied);
    if (fit === "contradicts") {
      throw invalidOutput("Codex finished a message whose content contradicts its stream");
    }
    if (fit === "splits") {
      throw invalidOutput(
        "Codex returned message content this request cannot represent (streamed text around a refusal)",
      );
    }
    item.content = supplied;
    return finished(state, item, () => closeStreamedText(item, supplied ?? []));
  }
  if (kind === "reasoning") {
    const reasoning = decode(ReasoningItem, payload, () =>
      invalidOutput("Codex sent incomplete reasoning"),
    );
    // Declared summary and reasoning-text parts must be in what the finished item supplies, with
    // their streamed values (a start's snapshot does not constrain it, as before it seeded parts).
    for (const [index, slot] of item.summaries) {
      if (!slot.declared) continue;
      const part = reasoning.summary[index];
      if (part === undefined || (slot.known && !slot.seeded && part.text !== current(slot))) {
        throw contradiction();
      }
    }
    for (const [index, slot] of item.reasoningTexts) {
      const part = reasoning.content?.[index];
      if (part === undefined || (slot.known && part.text !== current(slot))) throw contradiction();
    }
    item.summary = reasoning.summary.map(({ text }) => text).join("\n");
    item.reasoningContent = reasoning.content?.map((part) => part.text);
    // An unfinished item's done event omitting encrypted content keeps what it supplied before; a
    // stated value (null included), and a completed item's done event, replace it.
    if (!item.unfinished || reasoning.encrypted_content !== undefined) {
      item.encryptedContent = reasoning.encrypted_content;
    }
    // The finished summary replaces the streamed and seeded parts (the done item's id is the item's).
    item.summaries.clear();
    for (const [index, { text }] of reasoning.summary.entries()) {
      item.summaries.set(index, finalSlot("text", text, false));
    }
    return finished(state, item, () => reasoningPartsOf(item));
  }
  const done = decode(FunctionCallDoneItem, payload, () =>
    invalidOutput("Codex completed an unknown Tool call"),
  );
  // Identity the done item omits is taken from the started call; identity it states must agree.
  if (identityContradicts(item, done)) {
    throw invalidOutput("Codex completed a Tool call that contradicts its start");
  }
  const name = item.name ?? "";
  const callId = item.callId ?? "";
  if (item.unfinished) {
    // Its own supplied arguments (the done item's, else those a final-arguments event finalized) are
    // kept for the incomplete terminal, which shows them if they are complete JSON (a complete
    // response rejects an unfinished call, which is never dispatchable).
    item.finalArguments = done.arguments ?? item.finalArguments;
    return finished(state, item, () => []);
  }
  // The arguments the protocol supplied (done item, else start plus deltas) must be JSON
  // themselves; missing or empty arguments are not read as `{}`.
  item.params = parseArguments(done.arguments ?? item.arguments, name);
  // Arguments the done item states must complete everything known before it: the finalized
  // arguments (the same value), else the accumulated start and deltas (extended or equal).
  if (
    done.arguments !== undefined &&
    (item.finalArguments !== undefined
      ? !Equal.equals(item.params, parseArguments(item.finalArguments, name))
      : !completesArguments(item.arguments, done.arguments))
  ) {
    throw contradiction();
  }
  return finished(state, item, () => [
    Response.makePart("tool-params-end", { id: callId }),
    Response.makePart("tool-call", {
      id: callId,
      name,
      params: item.params,
      providerExecuted: false,
    }),
  ]);
};

/**
 * A finished item's final parts, emitted now unless it or an earlier item finished with a
 * non-completed status: an unfinished item is shown at the incomplete terminal, after its listing is
 * merged, so it and every item finished after it wait there in done order (native final parts keep
 * their end order). Deltas are never deferred; a complete terminal rejects the response.
 */
const finished = (
  state: StreamState,
  item: Item,
  parts: () => Array<Response.StreamPartEncoded>,
): Array<Response.StreamPartEncoded> => {
  if (!item.unfinished && state.deferred.length === 0) return parts();
  state.deferred.push({ item, parts: item.unfinished ? undefined : parts() });
  return [];
};

const current = (slot: Slot) => slot.final ?? slot.value;

/**
 * The indexed part a sub-event is about, which it declares. An explicit index names that part
 * (created on first sight; its type must not change unless only a snapshot supplied it); without
 * one, the event names the item's only declared part of its type, and `undefined` means the item
 * has no declared parts yet (parts only a snapshot supplied are not named without an index).
 */
const slotOf = (
  slots: Map<number, Slot>,
  index: number | undefined,
  type: Slot["type"],
): Slot | undefined => {
  if (index === undefined) {
    const declared = [...slots.values()].filter((slot) => slot.declared);
    const same = declared.filter((slot) => slot.type === type);
    if (same.length === 1) return same[0];
    if (declared.length === 0) return undefined;
    throw invalidOutput("Codex sent a content event that names no single content part");
  }
  const existing = slots.get(index);
  if (existing !== undefined && (existing.declared || existing.type === type)) {
    if (existing.type !== type) throw contradiction();
    existing.declared = true;
    return existing;
  }
  const slot: Slot = {
    type,
    value: "",
    final: undefined,
    known: false,
    started: false,
    seeded: false,
    declared: true,
  };
  slots.set(index, slot);
  return slot;
};

/**
 * A locator-less event supplying a value for a part whose value is only a snapshot's replaces the
 * snapshot values (as before they were seeded): parts only a snapshot supplied are dropped, and a
 * declared one keeps its declaration without a value.
 */
const replaceSeeds = (slots: Map<number, Slot>, slot: Slot, index: number | undefined) => {
  if (index !== undefined || !slot.seeded) return;
  for (const [at, part] of slots) {
    if (!part.seeded) continue;
    if (!part.declared) {
      slots.delete(at);
      continue;
    }
    part.value = "";
    part.known = false;
    part.seeded = false;
  }
};

/** Appends a delta to a part that is not yet finalized (a seeded value is its prefix). */
const appendSlot = (slot: Slot, delta: string) => {
  if (slot.final !== undefined) throw contradiction();
  slot.value += delta;
  slot.known = true;
  slot.seeded = false;
};

/** Adds a part event's own starting value: it replaces a seeded value, else extends the part. */
const addPart = (slot: Slot, value: string) => {
  if (value === "") return;
  if (!slot.seeded) return appendSlot(slot, value);
  slot.value = value;
  slot.seeded = false;
};

/** Finalizes a part: a repeated or streamed (not only seeded) value must agree with the final one. */
const finishSlot = (slot: Slot, value: string) => {
  if (
    slot.final !== undefined
      ? value !== slot.final
      : slot.known && !slot.seeded && value !== slot.value
  ) {
    throw invalidOutput("Codex finished a message whose content contradicts its stream");
  }
  slot.final = value;
  slot.known = true;
  slot.seeded = false;
};

/** A part a finished item supplied: known and final. */
const finalSlot = (type: Slot["type"], value: string, started: boolean): Slot => ({
  type,
  value,
  final: value,
  known: true,
  started,
  seeded: false,
  declared: true,
});

/**
 * Merges a supplied snapshot's parts (an item start's, or an Incomplete listing of an item not
 * completed) into its indexed parts by position: a part at an index already held must repeat it
 * (its type, and its value once known), and the others are seeded. When one does not, nothing is
 * merged: `false`.
 */
const mergeSnapshot = (slots: Map<number, Slot>, parts: ReadonlyArray<ContentPart>) => {
  const typed = parts.map((part) =>
    "text" in part ? (["text", part.text] as const) : (["refusal", part.refusal] as const),
  );
  const conflicts = typed.some(([type, value], index) => {
    const slot = slots.get(index);
    return slot !== undefined && (slot.type !== type || (slot.known && current(slot) !== value));
  });
  if (conflicts) return false;
  for (const [index, [type, value]] of typed.entries()) {
    const slot = slots.get(index);
    if (slot?.known === true) continue;
    // A declared part's snapshot value keeps its declaration.
    const declared = slot?.declared ?? false;
    slots.set(index, {
      type,
      value,
      final: undefined,
      known: true,
      started: false,
      seeded: true,
      declared,
    });
  }
  return true;
};

/**
 * Finishes a message not streamed as locator-less text: supplied done content must hold every
 * declared part at its index with the same type and streamed value; sparse done content is the
 * parts in index order. That content replaces the message's parts, each final (a streamed text
 * part stays started), except a part of an unfinished item that has no value yet.
 */
const finishMessage = (item: Item, supplied: ReadonlyArray<ContentPart> | undefined) => {
  const indices = [...item.slots.keys()].sort((a, b) => a - b);
  const toPart = (slot: Slot): ContentPart =>
    slot.type === "text" ? { text: current(slot) } : { refusal: current(slot) };
  const entries: Array<readonly [number, ContentPart]> =
    supplied === undefined
      ? indices.map((index) => [index, toPart(item.slots.get(index)!)] as const)
      : supplied.map((part, index) => [index, part] as const);
  if (supplied !== undefined) {
    for (const index of indices) {
      const slot = item.slots.get(index)!;
      // A declared part must be supplied with its type and streamed value (a start's snapshot does
      // not constrain the finished content, as before it seeded parts).
      if (!slot.declared) continue;
      const part = supplied[index];
      const value = part === undefined ? undefined : "text" in part ? part.text : part.refusal;
      if (
        part === undefined ||
        ("text" in part ? "text" : "refusal") !== slot.type ||
        (slot.known && !slot.seeded && value !== current(slot))
      ) {
        throw invalidOutput("Codex finished a message whose content contradicts its stream");
      }
    }
  }
  item.content = entries.map(([, part]) => part);
  const finalSlots = entries.map(([index, part]) => {
    const slot = item.slots.get(index);
    // Sparse done content of an unfinished item supplies no value for a part without one: it stays
    // declared and unknown (not shown unless its listing supplies it). A completed item's is empty.
    if (supplied === undefined && item.unfinished && slot !== undefined && !slot.known) {
      return [index, slot] as const;
    }
    return [
      index,
      "text" in part
        ? finalSlot("text", part.text, slot?.started === true)
        : finalSlot("refusal", part.refusal, false),
    ] as const;
  });
  item.slots.clear();
  for (const [index, slot] of finalSlots) item.slots.set(index, slot);
};

/**
 * A message's indexed parts as stream parts, in index order: a streamed text part ends here, any
 * other known part is emitted whole (a refusal as the native empty text part with its
 * explanation). An open item's empty streamed text is not shown; a finished item's is.
 */
const messageParts = (item: Item) =>
  [...item.slots.keys()]
    .sort((a, b) => a - b)
    .flatMap((index): Array<Response.StreamPartEncoded> => {
      const slot = item.slots.get(index)!;
      const id = `${item.partId}~${index}`;
      const value = current(slot);
      if (slot.type === "refusal") return slot.known ? refusalPart(id, value) : [];
      if (slot.started) return [Response.makePart("text-end", { id })];
      if (!slot.known || (value === "" && !slot.seeded && !item.done)) return [];
      return [
        Response.makePart("text-start", { id }),
        ...(value === "" ? [] : [Response.makePart("text-delta", { id, delta: value })]),
        Response.makePart("text-end", { id }),
      ];
    });

/** A reasoning item's known summary parts and encrypted content as native reasoning parts. */
const reasoningPartsOf = (item: Item) => {
  const summary = [...item.summaries.entries()]
    .sort(([a], [b]) => a - b)
    .flatMap(([, slot]) => (slot.known ? [current(slot)] : []));
  return reasoningParts(item.itemId, item.partId, summary.join("\n"), item.encryptedContent);
};

/**
 * Content a listing extends: each part both have at one position must be equal; the longer
 * supplies the rest. `undefined` when they differ.
 */
const extendContent = (
  own: ReadonlyArray<ContentPart>,
  listed: ReadonlyArray<ContentPart>,
): ReadonlyArray<ContentPart> | undefined =>
  listed.every((part, index) => index >= own.length || Equal.equals(part, own[index]))
    ? [...own, ...listed.slice(own.length)]
    : undefined;

/**
 * How content fits a message's streamed locator-less text, already emitted as one text part: its
 * text must repeat that text, not add to it (`contradicts`), and its refusals can only be placed
 * before or after that one part (`splits`).
 */
const streamedTextFit = (item: Item, content: ReadonlyArray<ContentPart>) => {
  const texts = content.flatMap((part) => ("text" in part ? [part.text] : []));
  if (texts.join("") !== item.text) return "contradicts";
  const first = content.findIndex((part) => "text" in part);
  const last = content.findLastIndex((part) => "text" in part);
  return first !== -1 && content.slice(first, last + 1).some((part) => "refusal" in part)
    ? "splits"
    : "fits";
};

/** Ends a message's streamed text part, with fitting content's refusals in content order. */
const closeStreamedText = (item: Item, content: ReadonlyArray<ContentPart>) => {
  const first = content.findIndex((part) => "text" in part);
  const last = content.findLastIndex((part) => "text" in part);
  const refusals = (placed: (index: number) => boolean) =>
    content.flatMap((part, index) =>
      "refusal" in part && placed(index)
        ? refusalPart(`${item.partId}~${index}`, part.refusal)
        : [],
    );
  return [
    ...refusals((index) => first === -1 || index < first),
    Response.makePart("text-end", { id: item.partId }),
    ...refusals((index) => first !== -1 && index > last),
  ];
};

/** Whether identity an item states (item id, call id, Tool name) contradicts the item it names. */
const identityContradicts = (
  item: Item,
  stated: {
    readonly id?: string | undefined;
    readonly call_id?: string | undefined;
    readonly name?: string | undefined;
  },
) =>
  (stated.id !== undefined && item.itemId !== undefined && stated.id !== item.itemId) ||
  (stated.call_id !== undefined && stated.call_id !== item.callId) ||
  (stated.name !== undefined && stated.name !== item.name);

const PartIndex = Schema.Struct({
  content_index: Schema.optional(Schema.Finite),
  summary_index: Schema.optional(Schema.Finite),
});
const partIndex = (event: Json) =>
  decode(PartIndex, event, () => invalidOutput("Codex sent malformed item keys"));
const ContentPartPayload = Schema.Struct({
  part: Schema.Struct({
    type: Schema.String,
    text: Schema.optional(Schema.String),
    refusal: Schema.optional(Schema.String),
  }),
});
const SummaryPartPayload = Schema.Struct({ part: SummaryText });

/** The started, unfinished reasoning item a reasoning sub-event is about. */
const openReasoning = (state: StreamState, event: Json): Item => {
  const { item } = locate(state, event, undefined, "reasoning");
  if (item === undefined || item.kind !== "reasoning" || item.done) {
    throw invalidOutput("Codex sent reasoning without a reasoning item");
  }
  return item;
};

/**
 * The text part of an open message a text event is about: by `content_index` when given (not
 * mixed with locator-less-indexed text), else the message's only indexed text part, else the one
 * locator-less-indexed text part (`undefined`).
 */
const messageTextSlot = (item: Item, event: Json): Slot | undefined => {
  const index = partIndex(event).content_index;
  if (index !== undefined && item.sawDelta) {
    throw invalidOutput("Codex sent a content event that names no single content part");
  }
  return slotOf(item.slots, index, "text");
};

/** The started, unfinished message a text or content event is about. */
const openMessage = (
  state: StreamState,
  event: Json,
  message = "Codex sent text without a message item",
): Item => {
  const { item } = locate(state, event, undefined, "message");
  if (item === undefined || item.kind !== "message" || item.done) throw invalidOutput(message);
  return item;
};

/**
 * The item a done event finishes. A function call done event without any locator is correlated
 * by its true `call_id`: the open call with that id, else a new done-only call.
 */
const locateDone = (
  state: StreamState,
  event: Json,
  payload: JsonInput,
  kind: Item["kind"],
  id: string | undefined,
) => {
  const { index, ids } = locatorsOf(event, id);
  if (kind === "function_call" && index === undefined && ids.length === 0) {
    const callId = decode(FunctionCallDoneItem, payload, () =>
      invalidOutput("Codex completed an unknown Tool call"),
    ).call_id;
    if (callId !== undefined) {
      const item = state.items.find((candidate) => candidate.callId === callId && !candidate.done);
      return { item, index, ids };
    }
  }
  return locate(state, event, id, kind);
};

/** The started, unfinished function call an argument event is about. */
const argumentsCall = (state: StreamState, event: Json, message: string): Item => {
  const { item } = locate(state, event, undefined, "function_call");
  if (item === undefined || item.kind !== "function_call" || item.done) {
    throw invalidOutput(message);
  }
  return item;
};

/** Whether arguments complete the accumulated ones: they extend them, or are the same JSON. */
const completesArguments = (accumulated: string, next: string) =>
  accumulated === "" || next.startsWith(accumulated) || sameJson(accumulated, next);

const isJson = (value: string) => {
  try {
    Tool.unsafeSecureJsonParse(value);
    return true;
  } catch {
    return false;
  }
};

/** Whether two argument strings are the same complete JSON value. */
const sameJson = (left: string, right: string) => {
  try {
    // SAFETY: JSON.parse output is Json by construction.
    const parse = (value: string) => Tool.unsafeSecureJsonParse(value) as Json;
    return Equal.equals(parse(left), parse(right));
  } catch {
    return false;
  }
};

const parseArguments = (arguments_: string, name: string): Json => {
  try {
    // SAFETY: JSON.parse output is Json by construction.
    return Tool.unsafeSecureJsonParse(arguments_) as Json;
  } catch {
    throw invalidOutput(`Invalid JSON arguments for Tool ${name}`);
  }
};

// A listed item is a complete Responses output item: a function call states its required fields.
const ListedCall = Schema.Struct({
  id: Schema.optional(Schema.String),
  call_id: Schema.String,
  name: Schema.String,
  arguments: Schema.String,
});
const ListedItem = Schema.Struct({ id: Schema.String });
const ListedReasoning = Schema.Struct({
  summary: Schema.optional(Schema.Array(SummaryText)),
  content: Schema.optional(
    Schema.Array(Schema.Struct({ type: Schema.Literal("reasoning_text"), text: Schema.String })),
  ),
  encrypted_content: Schema.optional(Schema.NullOr(Schema.String)),
});

/** Whether a listed message or reasoning item contradicts the finished streamed item. */
const listedContradicts = (item: Item, listed: JsonInput, onMalformed: () => AiError.AiError) => {
  if (item.kind === "message") {
    // Listed content must equal the item's, in order (a refusal cannot move past text).
    const content = messageContent(listed);
    const streamed = item.content ?? [{ text: item.text }];
    return content !== undefined && !Equal.equals(comparable(content), comparable(streamed));
  }
  const reasoning = decode(ListedReasoning, listed, onMalformed);
  const summary = reasoning.summary?.map(({ text }) => text).join("\n");
  const content = reasoning.content?.map(({ text }) => text);
  return (
    (summary !== undefined && summary !== item.summary) ||
    (content !== undefined &&
      item.reasoningContent !== undefined &&
      !Equal.equals(content, item.reasoningContent)) ||
    (reasoning.encrypted_content != null &&
      item.encryptedContent != null &&
      reasoning.encrypted_content !== item.encryptedContent)
  );
};

/**
 * A complete terminal response's non-empty `output` is the response's whole item list (Responses
 * API), so it must list exactly the streamed items: each listed item was streamed to completion
 * under the same identity (a call's `call_id`, and its item id when both are known), with the same
 * name, semantically equal arguments and the same supplied content; none has an explicit
 * non-completed status, and no streamed item is missing. Streamed events remain what is
 * dispatched. An absent or empty `output`, as the Codex CLI's own fixtures send, is not checked.
 */
const reconcileTerminalOutput = (state: StreamState, output: ReadonlyArray<Json>) => {
  const terminalContradiction = () =>
    invalidOutput("Codex completed a response whose output contradicts its stream");
  const matched = new Set<Item>();
  const listedIds = new Set<string>();
  for (const listed of output) {
    const { kind } = outputItemKind(listed);
    if (isUnfinished(itemStatus(listed))) throw terminalContradiction();
    let item: Item | undefined;
    if (kind === "function_call") {
      const call = decode(ListedCall, listed, terminalContradiction);
      item = state.items.find((candidate) => candidate.callId === call.call_id);
      if (
        item === undefined ||
        identityContradicts(item, call) ||
        !Equal.equals(parseArguments(call.arguments, call.name), item.params)
      ) {
        throw terminalContradiction();
      }
    } else {
      const { id } = decode(ListedItem, listed, terminalContradiction);
      item = state.byItemId.get(id);
      if (item === undefined || item.kind !== kind) throw terminalContradiction();
      if (listedContradicts(item, listed, terminalContradiction)) throw terminalContradiction();
    }
    if (matched.has(item)) throw terminalContradiction();
    matched.add(item);
    // A listed item id, even one the stream never gave this item, names this item only. With
    // every streamed item listed exactly once, a repeated id is the only way two items share one.
    const listedId = decode(OutputItem, listed, terminalContradiction).id;
    if (listedId !== undefined) {
      // It must not be another streamed item's id either, even one that item's listing omits.
      const owner = state.byItemId.get(listedId);
      if (listedIds.has(listedId) || (owner !== undefined && owner !== item)) {
        throw terminalContradiction();
      }
      listedIds.add(listedId);
    }
  }
  if (matched.size !== state.items.length) throw terminalContradiction();
};

/** A message's supplied content as stream parts, in content order (as its done event emits it). */
const contentParts = (partId: string, content: ReadonlyArray<ContentPart>) =>
  content.flatMap((part, index): Array<Response.StreamPartEncoded> => {
    const id = `${partId}~${index}`;
    if ("refusal" in part) return refusalPart(id, part.refusal);
    return [
      Response.makePart("text-start", { id }),
      ...(part.text === "" ? [] : [Response.makePart("text-delta", { id, delta: part.text })]),
      Response.makePart("text-end", { id }),
    ];
  });

/** Summary-only reasoning parts (private reasoning content is never shown). */
/** Native reasoning part metadata (`metadata.openai`). */
type ReasoningMetadata = { itemId?: string; encryptedContent?: string };

const reasoningParts = (
  itemId: string | undefined,
  partId: string,
  text: string,
  encryptedContent: string | null | undefined,
): Array<Response.StreamPartEncoded> => {
  const id = `${itemId ?? partId}:0`;
  // The same native metadata a finished reasoning item carries (item id, encrypted content).
  const openai: ReasoningMetadata = {};
  if (itemId !== undefined) openai.itemId = itemId;
  if (encryptedContent != null) openai.encryptedContent = encryptedContent;
  const metadata = { openai };
  return [
    Response.makePart("reasoning-start", { id, metadata }),
    ...(text === "" ? [] : [Response.makePart("reasoning-delta", { id, delta: text })]),
    Response.makePart("reasoning-end", { id, metadata }),
  ];
};

const IncompleteReasoning = Schema.Struct({
  id: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.Array(SummaryText)),
  content: Schema.optional(Schema.Array(ReasoningText)),
  encrypted_content: Schema.optional(Schema.NullOr(Schema.String)),
});
// A listed call's supplied fields; all three present (and JSON arguments) make it inspectable.
const IncompleteCall = Schema.Struct({
  call_id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  arguments: Schema.optional(Schema.String),
});

/**
 * The content an explicitly incomplete response already supplied, kept inspectable, in item order.
 * A listed item names a streamed one by id or call id, and the identity it states must agree with
 * it. An item not completed (open, or finished with a non-completed status and so not yet shown)
 * has its listing merged into what its stream, start snapshot and done item supplied, then is shown
 * once: equal and omitted parts keep them, other parts and encrypted content are added, and a
 * listing that contradicts them is not merged (the item keeps its own). Listed items the stream
 * did not carry follow. A listed item the stream completed must not contradict it. Listed ids and
 * call ids are unique. Calls with complete JSON arguments (their own, finalized or listed; omitted
 * identity is the stream's) are inspectable data, never dispatched: Core does not dispatch an
 * incomplete response. Nothing is completed or staged, and the list need not hold every item.
 */
const retainIncomplete = (
  state: StreamState,
  output: ReadonlyArray<Json>,
): Array<Response.StreamPartEncoded> => {
  const contradiction = () =>
    invalidOutput("Codex completed a response whose output contradicts its stream");
  type Listed = {
    readonly kind: Item["kind"];
    readonly id: string | undefined;
    readonly content: ReadonlyArray<ContentPart> | undefined;
    readonly reasoning: typeof IncompleteReasoning.Type | undefined;
    readonly call: typeof IncompleteCall.Type | undefined;
    readonly raw: Json;
  };
  const listed: Array<Listed> = [];
  const ids = new Set<string>();
  const callIds = new Set<string>();
  for (const raw of output) {
    const { kind, id } = outputItemKind(raw);
    itemStatus(raw);
    const call =
      kind === "function_call"
        ? decode(IncompleteCall, raw, () => invalidOutput("Codex sent an incomplete Tool call"))
        : undefined;
    if (id !== undefined) {
      if (ids.has(id)) throw contradiction();
      ids.add(id);
    }
    if (call?.call_id !== undefined) {
      if (callIds.has(call.call_id)) throw contradiction();
      callIds.add(call.call_id);
    }
    listed.push({
      kind,
      id,
      call,
      raw,
      content: kind === "message" ? messageContent(raw) : undefined,
      reasoning:
        kind === "reasoning"
          ? decode(IncompleteReasoning, raw, () => invalidOutput("Codex sent incomplete reasoning"))
          : undefined,
    });
  }
  /** The streamed item a listed item names by id (or, for a call, by call id). */
  const streamedOf = (entry: Listed) => {
    const byId = entry.id === undefined ? undefined : state.byItemId.get(entry.id);
    const byCall =
      entry.call?.call_id === undefined
        ? undefined
        : state.items.find((item) => item.callId === entry.call?.call_id);
    if (byId !== undefined && byCall !== undefined && byId !== byCall) throw contradiction();
    const item = byId ?? byCall;
    if (item === undefined) return undefined;
    if (item.kind !== entry.kind) throw contradiction();
    if (identityContradicts(item, { id: entry.id, ...entry.call })) throw contradiction();
    return item;
  };
  const matched = new Map<Item, Listed>();
  for (const entry of listed) {
    const item = streamedOf(entry);
    if (item === undefined) continue;
    if (item.done && !item.unfinished) {
      if (
        item.kind === "function_call"
          ? entry.call?.arguments !== undefined &&
            (!isJson(entry.call.arguments) ||
              !Equal.equals(parseArguments(entry.call.arguments, item.name ?? ""), item.params))
          : listedContradicts(item, entry.raw, contradiction)
      ) {
        throw contradiction();
      }
    }
    matched.set(item, entry);
  }
  const listedParts = (entry: Listed, partId: string): Array<Response.StreamPartEncoded> => {
    if (entry.content !== undefined) return contentParts(partId, entry.content);
    if (entry.reasoning !== undefined) {
      const summary = entry.reasoning.summary ?? [];
      const encrypted = entry.reasoning.encrypted_content;
      return summary.length > 0 || encrypted != null
        ? reasoningParts(entry.id, partId, summary.map(({ text }) => text).join("\n"), encrypted)
        : [];
    }
    const call = entry.call;
    if (
      call?.call_id === undefined ||
      call.name === undefined ||
      call.arguments === undefined ||
      !isJson(call.arguments)
    ) {
      return [];
    }
    return [
      Response.makePart("tool-call", {
        id: call.call_id,
        name: call.name,
        params: parseArguments(call.arguments, call.name),
        providerExecuted: false,
      }),
    ];
  };
  /** An item not completed, shown once: its listing merged into what it supplied. */
  const retained = (item: Item): Array<Response.StreamPartEncoded> => {
    const entry = matched.get(item);
    if (item.kind === "message") {
      const listedContent = entry?.content;
      if (item.sawDelta) {
        // Its own done content, extended by a listing that repeats it and fits the streamed text.
        const own = item.content ?? [];
        const merged = listedContent === undefined ? undefined : extendContent(own, listedContent);
        const fits = merged !== undefined && streamedTextFit(item, merged) === "fits";
        return closeStreamedText(item, fits ? merged : own);
      }
      if (listedContent !== undefined) mergeSnapshot(item.slots, listedContent);
      return messageParts(item);
    }
    if (item.kind === "reasoning") {
      const listing = entry?.reasoning;
      const encrypted = listing?.encrypted_content;
      const sameEncrypted =
        encrypted == null || item.encryptedContent == null || encrypted === item.encryptedContent;
      // Its summary and encrypted content are merged together, or not at all.
      if (
        listing !== undefined &&
        sameEncrypted &&
        mergeSnapshot(item.summaries, listing.summary ?? [])
      ) {
        if (encrypted != null) item.encryptedContent = encrypted;
      }
      const shown =
        item.done ||
        item.encryptedContent != null ||
        [...item.summaries.values()].some((slot) => slot.known);
      return shown ? reasoningPartsOf(item) : [];
    }
    // Complete JSON arguments are shown, never dispatched. A finished call's are its own; only
    // one that supplied none takes its listing's. An open call's are its listing's, else those
    // it finalized (which of two differing values is shown stays unresolved, as before).
    const own = item.done ? item.finalArguments : undefined;
    const arguments_ = own ?? entry?.call?.arguments ?? item.finalArguments;
    const name = item.name ?? "";
    // A finished call's shown arguments, its own or its listing's, must complete what it streamed.
    if (
      arguments_ === undefined ||
      !isJson(arguments_) ||
      (item.done && !completesArguments(item.arguments, arguments_))
    ) {
      return [];
    }
    return [
      Response.makePart("tool-call", {
        id: item.callId ?? "",
        name,
        params: parseArguments(arguments_, name),
        providerExecuted: false,
      }),
    ];
  };
  // Items finished since the first unfinished one, in done order (the completed ones' final parts
  // as their done events produced them), then the open items, in item order.
  const parts = state.deferred.flatMap(({ item, parts: final }) => final ?? retained(item));
  for (const item of state.items) if (!item.done) parts.push(...retained(item));
  for (const [position, entry] of listed.entries()) {
    if (streamedOf(entry) === undefined) parts.push(...listedParts(entry, `#terminal${position}`));
  }
  return parts;
};

// Terminal events carry completion status and usage; without a finish part the
// Session's finishReason/usage metadata would be silently absent for Codex.
const inputUsage = (total: number | undefined, cached: number | undefined) => {
  if (total === undefined) return cached === undefined ? {} : { cacheRead: cached };
  const base = { total, uncached: total - (cached ?? 0) };
  return cached === undefined ? base : { ...base, cacheRead: cached };
};

const outputUsage = (total: number | undefined, reasoning: number | undefined) => {
  if (total === undefined) return reasoning === undefined ? {} : { reasoning };
  return reasoning === undefined ? { total } : { total, reasoning };
};

const finishPart = (
  state: StreamState,
  event: Json,
  incompleteEvent: boolean,
): Array<Response.StreamPartEncoded> => {
  const decoded = decode(TerminalEvent, event, () =>
    invalidOutput("Codex sent a malformed terminal event"),
  );
  // Conservative guard: the event name is not trusted over an explicit response status carried
  // with it. Whether the backend ever sends a non-success status here is unestablished; if it does,
  // the response fails closed with a native error (or stays incomplete) instead of completing.
  const status = decoded.response?.status;
  if (state.terminal) throw invalidOutput("Codex sent a second terminal response event");
  state.terminal = true;
  // `response.incomplete` cannot hide an explicit failed, cancelled or other status either.
  if (
    status !== undefined &&
    status !== "incomplete" &&
    (incompleteEvent || status !== "completed")
  ) {
    if (status === "failed") {
      throw providerError(decoded.response?.error?.message ?? "Codex response failed");
    }
    if (status === "cancelled") {
      throw providerError(
        decoded.response?.error?.message ?? "Codex response was cancelled by the provider",
      );
    }
    throw invalidOutput(
      status === "in_progress" || status === "queued"
        ? `Codex returned a non-terminal response (status ${JSON.stringify(status)})`
        : `Codex returned an invalid response status: ${JSON.stringify(status)}`,
    );
  }
  const incomplete = incompleteEvent || status === "incomplete";
  // A complete response cannot leave a started Tool call unfinished: its group is malformed and
  // nothing of it may be dispatched. An explicitly incomplete response keeps its incomplete data.
  if (
    !incomplete &&
    state.items.some((item) => item.kind === "function_call" && (!item.done || item.unfinished))
  ) {
    throw invalidOutput("Codex completed a response with an unfinished Tool call");
  }
  if (!incomplete && state.items.some((item) => !item.done || item.unfinished)) {
    throw invalidOutput("Codex completed a response with unfinished output");
  }
  const output = decoded.response?.output ?? [];
  if (!incomplete && output.length > 0) reconcileTerminalOutput(state, output);
  const retained = incomplete ? retainIncomplete(state, output) : [];
  const reason = decoded.response?.incomplete_details?.reason;
  const usage = decoded.response?.usage;
  const cached = usage?.input_tokens_details?.cached_tokens;
  const reasoning = usage?.output_tokens_details?.reasoning_tokens;
  const finish = Response.makePart("finish", {
    reason:
      reason === undefined
        ? // An explicitly incomplete response without a reason is never a completion.
          incomplete
          ? "unknown"
          : state.items.some((item) => item.params !== undefined)
            ? "tool-calls"
            : "stop"
        : reason === "max_output_tokens"
          ? "length"
          : reason === "content_filter"
            ? "content-filter"
            : "unknown",
    usage: {
      inputTokens: inputUsage(usage?.input_tokens, cached),
      outputTokens: outputUsage(usage?.output_tokens, reasoning),
    },
  });
  return [...retained, finish];
};

const decodeEvent = (state: StreamState, data: string): Array<Response.StreamPartEncoded> => {
  if (data === "[DONE]") return [];
  const event = decode(Event, data, () => invalidOutput("Codex sent malformed SSE JSON"));
  // A non-string type is an unknown event: skipped below, like every malformed item.
  const rawType = event.type;
  const type = Predicate.isString(rawType) ? rawType : undefined;
  if (type === "error") {
    const decoded = decode(ErrorEvent, event, () => providerError("Codex provider error"));
    throw providerError(decoded.error?.message ?? decoded.message ?? "Codex provider error");
  }
  if (type === "response.failed") {
    const decoded = decode(FailedEvent, event, () => providerError("Codex response failed"));
    throw providerError(decoded.response?.error?.message ?? "Codex response failed");
  }
  if (type === "response.done" || type === "response.completed" || type === "response.incomplete") {
    return finishPart(state, event, type === "response.incomplete");
  }
  // Events that carry output cannot change a response after its terminal event validated it.
  const isOutputEvent =
    type === "response.output_item.added" ||
    type === "response.output_item.done" ||
    type === "response.output_text.delta" ||
    type === "response.function_call_arguments.delta" ||
    type === "response.function_call_arguments.done" ||
    type === "response.content_part.added" ||
    type === "response.content_part.done" ||
    type === "response.output_text.done" ||
    type === "response.refusal.delta" ||
    type === "response.refusal.done" ||
    type === "response.reasoning_summary_part.added" ||
    type === "response.reasoning_summary_part.done" ||
    type === "response.reasoning_summary_text.delta" ||
    type === "response.reasoning_summary_text.done" ||
    type === "response.reasoning_text.delta" ||
    type === "response.reasoning_text.done";
  if (isOutputEvent && state.terminal) {
    throw invalidOutput("Codex changed its output after the terminal response event");
  }
  if (type === "response.output_item.added") {
    return decodeOutputItemAdded(state, event, event.item);
  }
  if (type === "response.output_text.delta") {
    const decoded = decode(Delta, event, () =>
      invalidOutput("Codex sent text without a message item"),
    );
    const item = openMessage(state, event);
    const slot = messageTextSlot(item, event);
    if (slot !== undefined) {
      replaceSeeds(item.slots, slot, partIndex(event).content_index);
      const index = [...item.slots].find(([, candidate]) => candidate === slot)![0];
      const id = `${item.partId}~${index}`;
      // A seeded start or `content_part.added` value is the part's prefix; it is emitted once, first.
      const start = slot.started
        ? []
        : [
            Response.makePart("text-start", { id }),
            ...(slot.value === ""
              ? []
              : [Response.makePart("text-delta", { id, delta: slot.value })]),
          ];
      appendSlot(slot, decoded.delta);
      slot.started = true;
      return [...start, Response.makePart("text-delta", { id, delta: decoded.delta })];
    }
    // Locator-less text is the message's one separate text part; it does not extend a start's
    // seeded parts, which are not kept beside it (as before they were seeded).
    if (!item.sawDelta) item.slots.clear();
    const start = item.sawDelta ? [] : [Response.makePart("text-start", { id: item.partId })];
    item.text += decoded.delta;
    item.sawDelta = true;
    return [...start, Response.makePart("text-delta", { id: item.partId, delta: decoded.delta })];
  }
  if (type === "response.output_text.done") {
    const decoded = decode(OutputText, event, () =>
      invalidOutput("Codex sent text without a message item"),
    );
    const item = openMessage(state, event);
    const slot = messageTextSlot(item, event);
    if (slot !== undefined) {
      replaceSeeds(item.slots, slot, partIndex(event).content_index);
      finishSlot(slot, decoded.text);
      return [];
    }
    if (decoded.text !== item.text) {
      throw invalidOutput("Codex finished a message whose content contradicts its stream");
    }
    return [];
  }
  if (type === "response.refusal.delta" || type === "response.refusal.done") {
    const item = openMessage(state, event, "Codex sent a refusal without a message item");
    if (item.sawDelta) {
      throw invalidOutput("Codex sent a content event that names no single content part");
    }
    const index = partIndex(event).content_index;
    const slot = slotOf(item.slots, index, "refusal");
    if (slot === undefined) {
      throw invalidOutput("Codex sent a content event that names no single content part");
    }
    replaceSeeds(item.slots, slot, index);
    if (type === "response.refusal.delta") {
      appendSlot(
        slot,
        decode(Delta, event, () => invalidOutput("Codex sent a malformed message")).delta,
      );
    } else {
      finishSlot(
        slot,
        decode(Refusal, event, () => invalidOutput("Codex sent a malformed message")).refusal,
      );
    }
    return [];
  }
  if (
    type === "response.reasoning_summary_text.delta" ||
    type === "response.reasoning_summary_text.done" ||
    type === "response.reasoning_summary_part.added" ||
    type === "response.reasoning_summary_part.done" ||
    type === "response.reasoning_text.delta" ||
    type === "response.reasoning_text.done"
  ) {
    const item = openReasoning(state, event);
    const index = partIndex(event);
    const summary = !type.startsWith("response.reasoning_text");
    const slots = summary ? item.summaries : item.reasoningTexts;
    const malformed = () => invalidOutput("Codex sent incomplete reasoning");
    const locator = summary ? index.summary_index : index.content_index;
    // A locator-less event (the Codex CLI's summary delta) names the only declared part, else the
    // first part. Like locator-less message text, text it supplies does not extend a start's
    // summary; an empty part start supplies none, so it only declares the part.
    const slot = slotOf(slots, locator, "text") ?? slotOf(slots, 0, "text")!;
    const emptyStart =
      type === "response.reasoning_summary_part.added" &&
      decode(SummaryPartPayload, event, malformed).part.text === "";
    if (!emptyStart) replaceSeeds(slots, slot, locator);
    if (type.endsWith(".delta")) appendSlot(slot, decode(Delta, event, malformed).delta);
    else if (type.endsWith("_text.done"))
      finishSlot(slot, decode(OutputText, event, malformed).text);
    else {
      const { text } = decode(SummaryPartPayload, event, malformed).part;
      if (type.endsWith(".done")) finishSlot(slot, text);
      else addPart(slot, text);
    }
    return [];
  }
  if (type === "response.content_part.added" || type === "response.content_part.done") {
    const decoded = decode(ContentPartPayload, event, () =>
      invalidOutput("Codex sent a malformed message"),
    );
    const { part } = decoded;
    const index = partIndex(event).content_index;
    if (part.type === "reasoning_text") {
      const item = openReasoning(state, event);
      const slot = slotOf(item.reasoningTexts, index ?? 0, "text")!;
      if (type === "response.content_part.done") finishSlot(slot, part.text ?? "");
      else addPart(slot, part.text ?? "");
      return [];
    }
    const item = openMessage(state, event, "Codex sent message content without a message item");
    if (part.type !== "output_text" && part.type !== "refusal") {
      throw invalidOutput(
        `Codex returned message content this request cannot represent (${part.type})`,
      );
    }
    if (item.sawDelta || index === undefined) {
      throw invalidOutput("Codex sent a content event that names no single content part");
    }
    const value = part.type === "output_text" ? part.text : part.refusal;
    if (value === undefined) throw invalidOutput("Codex sent a malformed message");
    const slot = slotOf(item.slots, index, part.type === "output_text" ? "text" : "refusal")!;
    if (type === "response.content_part.done") finishSlot(slot, value);
    else addPart(slot, value);
    return [];
  }
  if (type === "response.function_call_arguments.delta") {
    const decoded = decode(Delta, event, () =>
      invalidOutput("Codex sent arguments without a Tool call"),
    );
    const call = argumentsCall(state, event, "Codex sent arguments without a Tool call");
    if (call.finalArguments !== undefined) throw contradiction();
    call.arguments += decoded.delta;
    return [
      Response.makePart("tool-params-delta", { id: call.callId ?? "", delta: decoded.delta }),
    ];
  }
  if (type === "response.function_call_arguments.done") {
    const decoded = decode(FinalArguments, event, () =>
      invalidOutput("Codex sent final arguments without a Tool call"),
    );
    const call = argumentsCall(state, event, "Codex sent final arguments without a Tool call");
    const arguments_ = decoded.arguments;
    // A repeated final-arguments event must repeat them, not replace them.
    if (call.finalArguments !== undefined) {
      if (arguments_ !== call.finalArguments) throw contradiction();
      return [];
    }
    // The first final arguments complete the streamed ones: they extend them, or are the same
    // complete JSON value; anything else contradicts what was streamed.
    if (!completesArguments(call.arguments, arguments_)) throw contradiction();
    call.finalArguments = arguments_;
    const delta = arguments_.startsWith(call.arguments)
      ? arguments_.slice(call.arguments.length)
      : "";
    call.arguments = arguments_;
    return delta === ""
      ? []
      : [Response.makePart("tool-params-delta", { id: call.callId ?? "", delta })];
  }
  if (type === "response.output_item.done") {
    return decodeOutputItemDone(state, event, event.item);
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
      parser: Sse.makeParser((event: Sse.AnyEvent) => {
        if (Predicate.isTagged(event, "Event")) events.push(event.data);
      }),
      items: [],
      byIndex: new Map(),
      byItemId: new Map(),
      deferred: [],
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
