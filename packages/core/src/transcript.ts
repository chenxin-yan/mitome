import { Encoding, Predicate, Result, Schema } from "effect";
import { Prompt } from "effect/unstable/ai";

/** Identifies a Transcript; a UUID when Mitome generates it. */
export type TranscriptId = string;

/** The `schemaVersion` written into every Transcript this version of Mitome produces. */
export const TranscriptSchemaVersion = 1 as const;

const options = Schema.optional(Prompt.ProviderOptions);
const textPart = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  options,
});
const reasoningPart = Schema.Struct({
  type: Schema.Literal("reasoning"),
  text: Schema.String,
  options,
});
const urlString = Schema.String.check(
  Schema.makeFilter((value) => (URL.canParse(value) ? undefined : "Expected an absolute URL")),
);
const base64String = Schema.String.check(
  Schema.makeFilter((value) =>
    Result.isSuccess(Encoding.decodeBase64(value)) ? undefined : "Expected a base64 string",
  ),
);
const fileData = Schema.Union([
  Schema.Struct({ encoding: Schema.Literal("string"), value: Schema.String }),
  Schema.Struct({ encoding: Schema.Literal("base64"), value: base64String }),
  Schema.Struct({ encoding: Schema.Literal("url"), value: urlString }),
]);
const filePart = Schema.Struct({
  type: Schema.Literal("file"),
  mediaType: Schema.String,
  fileName: Schema.optional(Schema.String),
  data: fileData,
  options,
});
const toolCallPart = Schema.Struct({
  type: Schema.Literal("tool-call"),
  id: Schema.String,
  name: Schema.String,
  params: Schema.Json,
  providerExecuted: Schema.optional(Schema.Boolean),
  options,
});
const toolResultPart = Schema.Struct({
  type: Schema.Literal("tool-result"),
  id: Schema.String,
  name: Schema.String,
  isFailure: Schema.Boolean,
  result: Schema.Json,
  providerExecuted: Schema.optional(Schema.Boolean),
  options,
});
const toolApprovalResponsePart = Schema.Struct({
  type: Schema.Literal("tool-approval-response"),
  approvalId: Schema.String,
  approved: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  options,
});
const toolApprovalRequestPart = Schema.Struct({
  type: Schema.Literal("tool-approval-request"),
  approvalId: Schema.String,
  toolCallId: Schema.String,
  options,
});
const userPart = Schema.Union([textPart, filePart]);
const assistantPart = Schema.Union([
  textPart,
  reasoningPart,
  filePart,
  toolCallPart,
  toolResultPart,
  toolApprovalRequestPart,
]);
const toolPart = Schema.Union([toolResultPart, toolApprovalResponsePart]);

/** Schema of one committed Message; file data is stored as a string, base64, or URL. */
export const TranscriptMessageSchema = Schema.Union([
  Schema.Struct({
    role: Schema.Literal("system"),
    content: Schema.String,
    options,
  }),
  Schema.Struct({
    role: Schema.Literal("user"),
    content: Schema.Array(userPart),
    options,
  }),
  Schema.Struct({
    role: Schema.Literal("assistant"),
    content: Schema.Array(assistantPart),
    options,
  }),
  Schema.Struct({
    role: Schema.Literal("tool"),
    content: Schema.Array(toolPart),
    options,
  }),
]);

/**
 * Schema of a Transcript. Stored bytes are a trust boundary: store adapters decode with it before
 * returning a Transcript.
 */
export const TranscriptSchema = Schema.Struct({
  schemaVersion: Schema.Literal(TranscriptSchemaVersion),
  id: Schema.String,
  parentTranscriptId: Schema.optional(Schema.String),
  messages: Schema.Array(TranscriptMessageSchema),
});

/** One committed Message of a Transcript. */
export type TranscriptMessage = typeof TranscriptMessageSchema.Type;
/**
 * The durable, ordered record of a Session's committed Messages. It may outlive the Session and
 * seed new ones; a resumed Session gets a new id with `parentTranscriptId` pointing at its seed.
 */
export type Transcript = typeof TranscriptSchema.Type;

/** Input to `makeTranscript`. */
export interface MakeTranscriptOptions {
  readonly id: TranscriptId;
  /** The Transcript this one was resumed from, if any. */
  readonly parentTranscriptId?: TranscriptId | undefined;
  readonly messages: ReadonlyArray<Prompt.Message>;
}

const encodeMessage = Schema.encodeSync(Prompt.Message);
const encodeUserMessageParts = Schema.encodeSync(Schema.Array(Prompt.UserMessagePart));
const encodeAssistantMessageParts = Schema.encodeSync(Schema.Array(Prompt.AssistantMessagePart));
const encodeToolMessageParts = Schema.encodeSync(Schema.Array(Prompt.ToolMessagePart));

const fileDataFromPrompt = (data: string | Uint8Array | URL) => {
  if (Predicate.isString(data)) return { encoding: "string", value: data } as const;
  if (data instanceof URL) return { encoding: "url", value: data.href } as const;
  return {
    encoding: "base64",
    value: Schema.encodeSync(Schema.Uint8ArrayFromBase64)(data),
  } as const;
};

const messageFromPrompt = (message: Prompt.Message) => {
  const encoded = encodeMessage(message);
  if (message.role === "system") return encoded;
  const content =
    message.role === "user"
      ? encodeUserMessageParts(message.content)
      : message.role === "assistant"
        ? encodeAssistantMessageParts(message.content)
        : encodeToolMessageParts(message.content);
  return {
    ...encoded,
    content: content.map((part) =>
      part.type === "file" ? { ...part, data: fileDataFromPrompt(part.data) } : part,
    ),
  };
};

/**
 * Encodes Model Prompt messages into a Transcript. Throws when a message cannot be represented, so
 * the Transcript never silently loses data.
 */
export const makeTranscript = (input: MakeTranscriptOptions): Transcript =>
  Schema.decodeUnknownSync(TranscriptSchema)({
    schemaVersion: TranscriptSchemaVersion,
    id: input.id,
    parentTranscriptId: input.parentTranscriptId,
    messages: input.messages.map(messageFromPrompt),
  });

const fileDataToPrompt = (data: typeof fileData.Type): string | Uint8Array | URL => {
  switch (data.encoding) {
    case "string":
      return data.value;
    case "base64":
      return Schema.decodeSync(Schema.Uint8ArrayFromBase64)(data.value);
    case "url":
      return new URL(data.value);
  }
};

const messageToPrompt = (message: TranscriptMessage) => {
  if (message.role === "system") return message;
  return {
    ...message,
    content: message.content.map((part) =>
      part.type === "file" ? { ...part, data: fileDataToPrompt(part.data) } : part,
    ),
  };
};

/** Decodes a Transcript back into the Model Prompt that seeds a Session. */
export const promptFromTranscript = (transcript: Transcript): Prompt.Prompt =>
  Schema.decodeUnknownSync(Prompt.Prompt)({
    content: transcript.messages.map(messageToPrompt),
  });
