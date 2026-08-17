import { Schema } from "effect";
import { Prompt } from "effect/unstable/ai";

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
const fileData = Schema.Union([
  Schema.Struct({ encoding: Schema.Literal("string"), value: Schema.String }),
  Schema.Struct({ encoding: Schema.Literal("base64"), value: Schema.String }),
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

export const TranscriptMessageSchema = Schema.Union([
  Schema.Struct({
    role: Schema.Literal("system"),
    content: Schema.String,
    options,
  }),
  Schema.Struct({
    role: Schema.Literal("user"),
    content: Schema.Union([Schema.String, Schema.Array(userPart)]),
    options,
  }),
  Schema.Struct({
    role: Schema.Literal("assistant"),
    content: Schema.Union([Schema.String, Schema.Array(assistantPart)]),
    options,
  }),
  Schema.Struct({
    role: Schema.Literal("tool"),
    content: Schema.Array(toolPart),
    options,
  }),
]);

export const TranscriptSchema = Schema.Struct({
  schemaVersion: Schema.Literal(TranscriptSchemaVersion),
  id: Schema.String,
  parentTranscriptId: Schema.optional(Schema.String),
  messages: Schema.Array(TranscriptMessageSchema),
});

export type TranscriptMessage = typeof TranscriptMessageSchema.Type;
export type Transcript = typeof TranscriptSchema.Type;

export interface MakeTranscriptOptions {
  readonly id: string;
  readonly parentTranscriptId?: string | undefined;
  readonly messages: ReadonlyArray<Prompt.Message>;
}

const encodeMessage = Schema.encodeSync(Prompt.Message);

const fileDataFromPrompt = (data: string | Uint8Array | URL) => {
  if (typeof data === "string") return { encoding: "string", value: data } as const;
  if (data instanceof URL) return { encoding: "url", value: data.href } as const;
  return {
    encoding: "base64",
    value: Schema.encodeSync(Schema.Uint8ArrayFromBase64)(data),
  } as const;
};

const messageFromPrompt = (message: Prompt.Message): unknown => {
  const encoded = encodeMessage(message);
  if (encoded.role === "system" || typeof encoded.content === "string") return encoded;
  return {
    ...encoded,
    content: encoded.content.map((part) =>
      part.type === "file" ? { ...part, data: fileDataFromPrompt(part.data) } : part,
    ),
  };
};

export const makeTranscript = (input: MakeTranscriptOptions): Transcript =>
  Schema.decodeUnknownSync(TranscriptSchema)({
    schemaVersion: TranscriptSchemaVersion,
    id: input.id,
    ...(input.parentTranscriptId === undefined
      ? {}
      : { parentTranscriptId: input.parentTranscriptId }),
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

const messageToPrompt = (message: TranscriptMessage): unknown => {
  if (message.role === "system" || typeof message.content === "string") return message;
  return {
    ...message,
    content: message.content.map((part) =>
      part.type === "file" ? { ...part, data: fileDataToPrompt(part.data) } : part,
    ),
  };
};

export const promptFromTranscript = (transcript: Transcript): Prompt.Prompt =>
  Schema.decodeUnknownSync(Prompt.Prompt)({
    content: transcript.messages.map(messageToPrompt),
  });
