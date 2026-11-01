import { Match, Predicate, Result, Schema } from "effect";
import { AiError, LanguageModel, type Prompt, Tool } from "effect/ai";
import { HttpClientError } from "effect/http";
import { type CredentialError } from "./credential-store.js";

const makeError = (reason: AiError.AiErrorReason) =>
  AiError.make({ module: "OpenAI Codex", method: "streamText", reason });

export const providerError = (description: string) =>
  makeError(new AiError.UnknownError({ description }));

export const invalidOutput = (description: string) =>
  makeError(new AiError.InvalidOutputError({ description }));

const authenticationError = (
  kind: "ExpiredKey" | "MissingKey" | "Unknown",
  description: string,
) => {
  const reason = new AiError.AuthenticationError({ kind });
  // Upstream's auth reason has a fixed API-key message getter; an own property
  // shadows it while keeping its taxonomy, naming the Codex login remedy.
  Object.defineProperty(reason, "message", { value: description });
  return makeError(reason);
};

export const httpError = (error: HttpClientError.HttpClientError) => {
  const reason = error.reason;
  return Predicate.isTagged(reason, "TransportError") ||
    Predicate.isTagged(reason, "EncodeError") ||
    Predicate.isTagged(reason, "InvalidUrlError")
    ? makeError(AiError.NetworkError.fromRequestError(reason))
    : providerError(error.message);
};

export const credentialError = (error: CredentialError) => {
  if (HttpClientError.isHttpClientError(error)) return httpError(error);
  return Match.value(error).pipe(
    Match.tagsExhaustive({
      CredentialUnavailableError: (error) => authenticationError("MissingKey", error.message),
      OAuthTokenError: (error) => authenticationError("ExpiredKey", error.message),
      OAuthCredentialError: (error) => authenticationError("Unknown", error.message),
      CredentialStoreError: (error) =>
        providerError(`${error.message}${error.code === undefined ? "" : ` (${error.code})`}`),
      TimeoutError: () => providerError("OAuth token exchange timed out"),
    }),
  );
};

const ReasoningOptions = Schema.Struct({
  itemId: Schema.String,
  encryptedContent: Schema.String,
});

const contentFor = (
  content: string | ReadonlyArray<{ readonly type: string; readonly text?: string }>,
) =>
  Array.isArray(content)
    ? content
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("")
    : content;

const RefusalOptions = Schema.Struct({ openai: Schema.Struct({ refusal: Schema.String }) });

/**
 * Whether a Prompt carries a refusal: an assistant text part whose `options.openai.refusal` keeps
 * the explanation (the native rc.117 form). The Codex request has no refusal input form (the Codex
 * CLI's `ContentItem` has none), so such a conversation is refused before any request rather than
 * sent without it or as ordinary text.
 */
export const hasRefusal = (prompt: Prompt.Prompt) =>
  prompt.content.some(
    (message) =>
      message.role === "assistant" &&
      message.content.some(
        (part) => part.type === "text" && Schema.is(RefusalOptions)(part.options),
      ),
  );

/**
 * The Codex wire `tool_choice` for a native Tool choice. The Codex CLI sends only the strings
 * `"auto"` and `"none"`; a restricting `oneOf` in `"auto"` mode is the native filtered Tool list
 * with `"auto"`. Other choices have no evidenced Codex form and are rejected before any request.
 */
export const toolChoiceFor = (
  choice: LanguageModel.ProviderOptions["toolChoice"],
): "auto" | "none" | undefined => {
  if (choice === "auto" || choice === "none") return choice;
  if (Predicate.isObject(choice) && "oneOf" in choice && choice.mode !== "required") return "auto";
  return undefined;
};

export const requestFor = (
  model: string,
  options: LanguageModel.ProviderOptions,
  sessionId: string,
  toolChoice: "auto" | "none",
) => {
  const system = options.prompt.content.find((message) => message.role === "system");
  const input: Array<typeof Schema.Json.Type> = [];
  for (const message of options.prompt.content) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type === "tool-result") {
          input.push({
            type: "function_call_output",
            call_id: part.id,
            output: JSON.stringify(part.result),
          });
        }
      }
      continue;
    }
    const content = contentFor(message.content);
    if (message.role === "assistant") {
      let contentPending = content !== "";
      for (const part of message.content) {
        if (part.type === "text" && contentPending) {
          input.push({ role: "assistant", content });
          contentPending = false;
        }
        if (part.type === "reasoning") {
          const decoded = Schema.decodeUnknownResult(ReasoningOptions)(part.options.openai);
          if (Result.isSuccess(decoded)) {
            input.push({
              type: "reasoning",
              id: decoded.success.itemId,
              encrypted_content: decoded.success.encryptedContent,
              summary: part.text === "" ? [] : [{ type: "summary_text", text: part.text }],
            });
          }
        }
        if (part.type === "tool-call") {
          input.push({
            type: "function_call",
            call_id: part.id,
            name: part.name,
            arguments: JSON.stringify(part.params),
          });
        }
      }
      continue;
    }
    input.push({ role: "user", content });
  }
  const request = {
    model,
    store: false,
    stream: true,
    instructions: system === undefined ? "" : contentFor(system.content),
    input,
    text: { verbosity: "low" },
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: sessionId,
    tool_choice: toolChoice,
    parallel_tool_calls: true,
  };
  if (options.tools.length === 0) return request;
  return {
    ...request,
    tools: options.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: Tool.getDescription(tool),
      parameters: Tool.getJsonSchema(tool),
      strict: null,
    })),
  };
};
