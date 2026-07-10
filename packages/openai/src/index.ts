import { Effect, Layer, Schema, Stream } from "effect";
import { AiError, LanguageModel, Response, Tool } from "effect/unstable/ai";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { Sse } from "effect/unstable/encoding";
import { makeModel, type Model } from "@mitome/core";

export type KnownModelId = "gpt-4o" | "gpt-4o-mini" | "gpt-4.1" | "gpt-4.1-mini" | "o3" | "o4-mini";
export type ModelId = KnownModelId | (string & {});

export interface Credential {
  readonly kind: "env";
  readonly name: string;
}

/** Declares the environment variable that supplies a provider credential at Session startup. */
export const env = (name: string): Credential => ({ kind: "env", name });

export interface OpenAiOptions {
  /** OpenAI-compatible API root, primarily for self-hosted compatible endpoints. */
  readonly baseUrl?: string;
}

export class MissingCredentialError extends Schema.TaggedErrorClass<MissingCredentialError>()(
  "MissingCredentialError",
  { message: Schema.String },
) {}

type OpenAiToolCall = {
  id?: unknown;
  index?: unknown;
  function?: { name?: unknown; arguments?: unknown };
};

type OpenAiDelta = { content?: unknown; tool_calls?: unknown };
type OpenAiEvent = { choices?: ReadonlyArray<{ delta?: OpenAiDelta }> };

type StreamState = {
  readonly events: Array<{ readonly data: string }>;
  readonly parser: Sse.Parser;
  readonly calls: Map<number, { id: string; name: string; arguments: string }>;
  textStarted: boolean;
  done: boolean;
};

const providerError = (reason: AiError.AiErrorReason) =>
  AiError.make({ module: "OpenAI", method: "streamText", reason });

const invalidOutput = (description: string) =>
  providerError(new AiError.InvalidOutputError({ description }));

const networkError = (cause: unknown) =>
  providerError(
    new AiError.UnknownError({
      description: cause instanceof Error ? cause.message : "OpenAI request failed",
    }),
  );

const contentFor = (content: ReadonlyArray<{ readonly type: string; readonly text?: string }>) =>
  content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");

const messagesFor = (prompt: LanguageModel.ProviderOptions["prompt"]) =>
  prompt.content.flatMap((message) => {
    if (message.role === "system") return [{ role: "system", content: message.content }];
    if (message.role === "user") return [{ role: "user", content: contentFor(message.content) }];
    if (message.role === "assistant") {
      const content = contentFor(message.content);
      const toolCalls = message.content
        .filter((part) => part.type === "tool-call")
        .map((part) => ({
          id: part.id,
          type: "function",
          function: { name: part.name, arguments: JSON.stringify(part.params) },
        }));
      return [
        {
          role: "assistant",
          content: content || null,
          ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
        },
      ];
    }
    return message.content
      .filter((part) => part.type === "tool-result")
      .map((part) => ({
        role: "tool",
        tool_call_id: part.id,
        content: JSON.stringify(part.result),
      }));
  });

const requestFor = (model: string, options: LanguageModel.ProviderOptions) => ({
  model,
  messages: messagesFor(options.prompt),
  stream: true,
  ...(options.tools.length === 0
    ? {}
    : {
        tools: options.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            ...(Tool.getDescription(tool) === undefined
              ? {}
              : { description: Tool.getDescription(tool) }),
            parameters: Tool.getJsonSchema(tool),
          },
        })),
      }),
  ...(options.toolChoice === "auto" ||
  options.toolChoice === "none" ||
  options.toolChoice === "required"
    ? { tool_choice: options.toolChoice }
    : "tool" in options.toolChoice
      ? { tool_choice: { type: "function", function: { name: options.toolChoice.tool } } }
      : {}),
});

const finish = (
  state: StreamState,
  skipMalformedTools = false,
): Array<Response.StreamPartEncoded> => {
  const parts: Array<Response.StreamPartEncoded> = [];
  if (state.textStarted) parts.push(Response.makePart("text-end", { id: "openai-text" }));
  for (const call of state.calls.values()) {
    parts.push(Response.makePart("tool-params-end", { id: call.id }));
    let params: unknown;
    try {
      params = Tool.unsafeSecureJsonParse(call.arguments || "{}");
    } catch {
      if (skipMalformedTools) continue;
      throw invalidOutput(`Invalid JSON arguments for Tool ${call.name}`);
    }
    parts.push(
      Response.makePart("tool-call", {
        id: call.id,
        name: call.name,
        params,
        providerExecuted: false,
      }),
    );
  }
  return parts;
};

const decodeEvent = (state: StreamState, data: string): Array<Response.StreamPartEncoded> => {
  if (data === "[DONE]") {
    state.done = true;
    return finish(state);
  }

  let event: OpenAiEvent;
  try {
    event = JSON.parse(data) as OpenAiEvent;
  } catch {
    throw invalidOutput("OpenAI sent malformed SSE JSON");
  }
  const delta = event.choices?.[0]?.delta;
  if (delta === undefined) return [];
  const parts: Array<Response.StreamPartEncoded> = [];
  if (typeof delta.content === "string") {
    if (!state.textStarted) {
      state.textStarted = true;
      parts.push(Response.makePart("text-start", { id: "openai-text" }));
    }
    parts.push(Response.makePart("text-delta", { id: "openai-text", delta: delta.content }));
  }
  if (Array.isArray(delta.tool_calls)) {
    for (const candidate of delta.tool_calls as ReadonlyArray<OpenAiToolCall>) {
      const index = candidate.index;
      const id = candidate.id;
      const name = candidate.function?.name;
      if (typeof index !== "number" || !Number.isInteger(index)) {
        throw invalidOutput("OpenAI sent a Tool call without an index");
      }
      let call = state.calls.get(index);
      if (call === undefined) {
        if (typeof id !== "string" || typeof name !== "string") {
          throw invalidOutput("OpenAI sent an incomplete Tool call");
        }
        call = { id, name, arguments: "" };
        state.calls.set(index, call);
        parts.push(
          Response.makePart("tool-params-start", {
            id: call.id,
            name: call.name,
            providerExecuted: false,
          }),
        );
      }
      const argumentsDelta = candidate.function?.arguments;
      if (typeof argumentsDelta === "string") {
        call.arguments += argumentsDelta;
        parts.push(Response.makePart("tool-params-delta", { id: call.id, delta: argumentsDelta }));
      }
    }
  }
  return parts;
};

const streamText = (
  model: string,
  credential: string,
  baseUrl: string,
  options: LanguageModel.ProviderOptions,
) => {
  const request = HttpClientRequest.post(`${baseUrl}/chat/completions`).pipe(
    HttpClientRequest.bearerToken(credential),
    HttpClientRequest.bodyJsonUnsafe(requestFor(model, options)),
  );
  return Stream.unwrap(
    HttpClient.execute(request).pipe(
      Effect.mapError(networkError),
      Effect.flatMap((response) => {
        if (response.status >= 200 && response.status < 300) {
          return Effect.succeed(HttpClientResponse.stream(Effect.succeed(response)));
        }
        return Effect.fail(
          providerError(AiError.reasonFromHttpStatus({ status: response.status })),
        );
      }),
    ),
  ).pipe(
    Stream.mapError((cause) => (AiError.isAiError(cause) ? cause : networkError(cause))),
    Stream.decodeText,
    Stream.mapAccumArrayEffect(
      () => {
        const events: StreamState["events"] = [];
        return {
          events,
          parser: Sse.makeParser((event) => {
            if (event._tag === "Event") events.push({ data: event.data });
          }),
          calls: new Map(),
          textStarted: false,
          done: false,
        } satisfies StreamState;
      },
      (state, chunk) =>
        Effect.try({
          try: () => {
            for (const value of chunk) state.parser.feed(value);
            const parts = state.events.splice(0).flatMap((event) => decodeEvent(state, event.data));
            return [state, parts] as const;
          },
          catch: (cause) =>
            AiError.isAiError(cause) ? cause : invalidOutput("OpenAI stream failed"),
        }),
      {
        // onHalt cannot report typed failures, so retain valid parts and skip malformed tools.
        onHalt: (state) => (state.done ? [] : finish(state, true)),
      },
    ),
    Stream.provide(FetchHttpClient.layer),
  );
};

/** Creates the canonical Model backed by OpenAI Chat Completions streaming. */
export const openai = (
  model: ModelId,
  credential: Credential,
  options: OpenAiOptions = {},
): Model => {
  const baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  return makeModel(
    Layer.effect(
      LanguageModel.LanguageModel,
      Effect.gen(function* () {
        const value = process.env[credential.name];
        if (value === undefined || value === "") {
          return yield* new MissingCredentialError({
            message: `Missing environment variable ${credential.name}`,
          });
        }
        const stream = (providerOptions: LanguageModel.ProviderOptions) =>
          streamText(model, value, baseUrl, providerOptions);
        return yield* LanguageModel.make({
          streamText: stream,
          generateText: (providerOptions) =>
            Stream.runCollect(stream(providerOptions)).pipe(
              Effect.map((parts) => {
                const text = [...parts]
                  .filter((part) => part.type === "text-delta")
                  .map((part) => part.delta)
                  .join("");
                return [
                  ...(text === "" ? [] : [Response.makePart("text", { text })]),
                  ...[...parts].filter((part) => part.type === "tool-call"),
                ];
              }),
            ),
        });
      }),
    ),
  );
};
