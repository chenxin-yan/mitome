// An offline native application for the CLI tests: a scripted Model, no network or credentials.
// Set MITOME_FIXTURE_LOG to record what was acquired, provisioned, run and cleaned up, and
// MITOME_FIXTURE_HOLD_RELEASE to make releasing the infrastructure never finish.
import { appendFileSync } from "node:fs";
import {
  defineMitome,
  firstPartyExecutionLimits,
  loop,
  makeProvider,
  reportModelRequest,
  Turn,
  withModelRequestAccounting,
} from "@mitome/core";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { LanguageModel, Prompt } from "effect/ai";

const record = (event: string) => {
  const file = process.env.MITOME_FIXTURE_LOG;
  if (file !== undefined) appendFileSync(file, `${event}\n`);
};

class Greeting extends Context.Service<Greeting, { readonly prefix: string }>()(
  "fixture/Greeting",
) {}

class Unparseable extends Schema.TaggedError<Unparseable>()("Unparseable", {}) {
  override get message(): string {
    return "unparseable input";
  }
}

class Refused extends Schema.TaggedError<Refused>()("Refused", { reason: Schema.String }) {
  override get message(): string {
    return `refused: ${this.reason}`;
  }
}

/** Echoes the last user text, prefixed with the provisioned Model id. */
const echoModel = (modelId: string) =>
  withModelRequestAccounting(
    "fixture",
    Layer.effect(
      LanguageModel.LanguageModel,
      LanguageModel.make({
        generateText: (options) =>
          Effect.gen(function* () {
            yield* reportModelRequest;
            const user = options.prompt.content.findLast((message) => message.role === "user");
            const said = user?.content.map((part) => (part.type === "text" ? part.text : "")) ?? [];
            return [
              { type: "text", text: `${modelId}: ${said.join("")}` },
              { type: "finish", reason: "stop", usage: { inputTokens: {}, outputTokens: {} } },
            ];
          }),
        streamText: () => Stream.die(new Error("not streamed")),
      }),
    ),
  );

const scripted = makeProvider(
  "scripted",
  ["echo"],
  "FIXTURE_API_KEY",
  (modelId) => {
    if (modelId === "defect") throw new ReferenceError("fixture provisioning defect");
    return Layer.unwrap(
      Effect.gen(function* () {
        record(`provision:${modelId}`);
        yield* Effect.addFinalizer(() => Effect.sync(() => record(`release-model:${modelId}`)));
        return echoModel(modelId);
      }),
    );
  },
  { echo: { contextWindow: 8192 } },
);

const oauth = makeProvider(
  "oauth",
  [],
  { capability: { module: new URL("./capability.ts", import.meta.url).href } },
  () => echoModel("oauth"),
);

const infrastructure = Layer.effect(
  Greeting,
  Effect.acquireRelease(
    Effect.sync(() => (record("infra:acquire"), { prefix: "> " })),
    () =>
      process.env.MITOME_FIXTURE_HOLD_RELEASE === undefined
        ? Effect.sync(() => record("infra:release"))
        : Effect.never,
  ),
);

/**
 * The ordinary program; `hold` and `wait` exercise shutdown with stuck and prompt cleanup, and
 * `log` writes an application log line.
 */
export const program = (message: string) =>
  Effect.gen(function* () {
    record(`program:${message}`);
    const turn = yield* Turn;
    if (message === "log") yield* Effect.logInfo("fixture log line");
    if (message === "fail") return yield* new Refused({ reason: "asked to fail" });
    if (message === "hold" || message === "wait") {
      yield* Effect.addFinalizer(() =>
        message === "hold" ? Effect.never : Effect.sync(() => record("turn:cleanup")),
      );
      record(`turn:${message}`);
      return yield* Effect.never;
    }
    yield* turn.stage(Prompt.userMessage({ content: [Prompt.textPart({ text: message })] }));
    const result = yield* loop({});
    return { text: result.response.text, turn: turn.id };
  });

export default defineMitome({
  program,
  limits: firstPartyExecutionLimits,
  infrastructure,
  providers: [scripted, oauth],
  defaultModel: "scripted/echo",
  configDirectory: process.env.MITOME_FIXTURE_CREDENTIALS,
  cli: {
    parseInput: (text: string) =>
      text.trim() === "unparseable" ? Effect.fail(new Unparseable()) : Effect.succeed(text.trim()),
    renderResult: (result) =>
      result.text.endsWith("unrenderable")
        ? Effect.fail(new Refused({ reason: "cannot render" }))
        : Effect.map(Greeting, ({ prefix }) => `${prefix}${result.text}`),
  },
});
