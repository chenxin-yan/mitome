import { AiError, LanguageModel, Tool } from "effect/unstable/ai";

export const providerError = (description: string) =>
  AiError.make({
    module: "OpenAI Codex",
    method: "streamText",
    reason: new AiError.UnknownError({ description }),
  });

export const invalidOutput = (description: string) =>
  AiError.make({
    module: "OpenAI Codex",
    method: "streamText",
    reason: new AiError.InvalidOutputError({ description }),
  });

export const networkError = (cause: unknown) =>
  providerError(cause instanceof Error ? cause.message : "Codex request failed");

const contentFor = (
  content: string | ReadonlyArray<{ readonly type: string; readonly text?: string }>,
) =>
  typeof content === "string"
    ? content
    : content
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("");

export const requestFor = (
  model: string,
  options: LanguageModel.ProviderOptions,
  sessionId: string,
) => {
  const system = options.prompt.content.find((message) => message.role === "system");
  const input: Array<Record<string, unknown>> = [];
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
      if (content !== "") input.push({ role: "assistant", content });
      for (const part of message.content) {
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
  return {
    model,
    store: false,
    stream: true,
    instructions: system === undefined ? "" : contentFor(system.content),
    input,
    text: { verbosity: "low" },
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: sessionId,
    tool_choice: "auto",
    parallel_tool_calls: true,
    ...(options.tools.length === 0
      ? {}
      : {
          tools: options.tools.map((tool) => ({
            type: "function",
            name: tool.name,
            ...(Tool.getDescription(tool) === undefined
              ? {}
              : { description: Tool.getDescription(tool) }),
            parameters: Tool.getJsonSchema(tool),
            strict: null,
          })),
        }),
  };
};
