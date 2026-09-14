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
import type { TurnFrame } from "../../src/http/index.js";

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

export const promptText = (prompt: Prompt.Prompt): string => JSON.stringify(prompt);
