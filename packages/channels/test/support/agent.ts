import {
  type AgentDefinition,
  type ChannelHostContext,
  makeProvider,
  memoryTranscripts,
} from "@mitome/core";
import { Effect, Layer, Schema, Stream } from "effect";
import {
  type AiError,
  LanguageModel,
  type Prompt,
  type Response,
  Tool,
  Toolkit,
} from "effect/unstable/ai";

type StreamText = (
  options: LanguageModel.ProviderOptions,
) => Stream.Stream<Response.StreamPartEncoded, AiError.AiError>;

// Built through the real LanguageModel.make so Tool Calls run Core's preparation (Hooks,
// policy, Approval) as under a real Provider. Sibling copy: packages/core/test/support/provider.ts.
export const makeTestProvider = (streamText: StreamText, release: () => void = () => undefined) =>
  makeProvider("test", [] as const, undefined, () =>
    Layer.effect(
      LanguageModel.LanguageModel,
      Effect.acquireRelease(
        LanguageModel.make({
          streamText,
          generateText: () => Effect.die("generateText is not used by these tests"),
        }),
        () => Effect.sync(release),
      ),
    ),
  );

/** A Model that answers every Step with one text delta and records the prompts it saw. */
export const echoModel = (reply = "hi") => {
  const prompts: Array<Prompt.Prompt> = [];
  let released = 0;
  const provider = makeTestProvider(
    (options) => {
      prompts.push(options.prompt);
      return Stream.succeed({ type: "text-delta", id: "reply", delta: reply });
    },
    () => {
      released += 1;
    },
  );
  return { provider, prompts, released: () => released };
};

/** A Model whose first Step never ends after one delta; a Turn on it only ends by interruption. */
export const hangingModel = () => {
  let released = 0;
  const provider = makeTestProvider(
    () =>
      Stream.concat(
        Stream.succeed({ type: "text-delta" as const, id: "first", delta: "thinking" }),
        Stream.never,
      ),
    () => {
      released += 1;
    },
  );
  return { provider, released: () => released };
};

/**
 * A Model that calls the named Tools once each in its first Step and then replies `done`; every
 * Tool is declared with `needsApproval` as listed and a handler that counts its executions.
 */
export const toolModel = (tools: ReadonlyArray<{ name: string; needsApproval: boolean }>) => {
  let calls = 0;
  const executions = new Map<string, number>();
  const provider = makeTestProvider(() => {
    calls += 1;
    if (calls > 1) return Stream.succeed({ type: "text-delta", id: "done", delta: "done" });
    return Stream.fromIterable(
      tools.map((tool) => ({
        type: "tool-call" as const,
        id: `call-${tool.name}`,
        name: tool.name,
        params: { action: "run" },
      })),
    );
  });
  const extension = {
    name: "tools",
    toolkit: Toolkit.make(
      ...tools.map((tool) =>
        Tool.make(tool.name, {
          parameters: Schema.Struct({ action: Schema.String }),
          success: Schema.String,
          needsApproval: tool.needsApproval,
        }),
      ),
    ),
    handlers: Object.fromEntries(
      tools.map((tool) => [
        tool.name,
        () =>
          Effect.sync(() => {
            executions.set(tool.name, (executions.get(tool.name) ?? 0) + 1);
            return "executed";
          }),
      ]),
    ),
  };
  return { provider, extension, executions, steps: () => calls };
};

export const agentWith = (
  provider: AgentDefinition["providers"][number],
  extensions: AgentDefinition["extensions"] = [],
  approvals?: AgentDefinition["approvals"],
): AgentDefinition => ({ providers: [provider], model: "test/default", extensions, approvals });

export const contextFor = (agent: AgentDefinition): ChannelHostContext => ({
  agent,
  transcripts: memoryTranscripts(),
});

export const promptText = (prompt: Prompt.Prompt): string => JSON.stringify(prompt);
