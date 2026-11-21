// An offline Configuration for the CLI tests: a scripted Model, no network or credentials.
// Set MITOME_FIXTURE_LOG to record what was acquired, provisioned, run and cleaned up, and
// MITOME_FIXTURE_HOLD_RELEASE to make releasing the layer never finish.
import { Effect, Layer, Stream } from "effect";
import { LanguageModel } from "effect/ai";
import { Mitome, Provider, reportModelRequest, withModelRequestAccounting } from "@mitome/core";
import { record } from "../record.ts";
import { agent, Greeting } from "./agent.ts";

/**
 * Echoes the last user text, prefixed with the provisioned Model id; `charge` first asks for one
 * Tool Call, and the next request's Tool result is recorded as `request:<result>`.
 */
export const echoModel = (modelId: string) =>
  withModelRequestAccounting(
    "fixture",
    Layer.effect(
      LanguageModel.LanguageModel,
      LanguageModel.make({
        generateText: (options) =>
          Effect.gen(function* () {
            yield* reportModelRequest;
            const last = options.prompt.content.at(-1);
            const user = options.prompt.content.findLast((message) => message.role === "user");
            const said = user?.content.map((part) => (part.type === "text" ? part.text : "")) ?? [];
            if (said.join("") === "charge" && last?.role === "user") {
              return [
                { type: "tool-call", id: "call-1", name: "charge", params: { cents: "250" } },
                {
                  type: "finish",
                  reason: "tool-calls",
                  usage: { inputTokens: {}, outputTokens: {} },
                },
              ];
            }
            let reply = said.join("");
            if (last?.role === "tool") {
              const part = last.content.find((part) => part.type === "tool-result");
              record(`request:${JSON.stringify(part?.result)}`);
              reply = part?.isFailure === true ? "not charged" : "charged";
            }
            return [
              { type: "text", text: `${modelId}: ${reply}` },
              { type: "finish", reason: "stop", usage: { inputTokens: {}, outputTokens: {} } },
            ];
          }),
        streamText: () => Stream.die(new Error("not streamed")),
      }),
    ),
  );

const scripted = Provider.make("scripted", {
  modelIds: ["echo"],
  credential: "FIXTURE_API_KEY",
  provision: (modelId) => {
    if (modelId === "defect") throw new ReferenceError("fixture provisioning defect");
    return Layer.unwrap(
      Effect.gen(function* () {
        record(`provision:${modelId}`);
        yield* Effect.addFinalizer(() => Effect.sync(() => record(`release-model:${modelId}`)));
        return echoModel(modelId);
      }),
    );
  },
  models: { echo: { contextWindow: 8192 } },
});

const oauth = Provider.make("oauth", {
  modelIds: [],
  credential: { capability: { module: new URL("../capability.ts", import.meta.url).href } },
  provision: () => echoModel("oauth"),
});

const layer = Layer.effect(
  Greeting,
  Effect.acquireRelease(
    Effect.sync(() => (record("infra:acquire"), { prefix: "> " })),
    () =>
      process.env.MITOME_FIXTURE_HOLD_RELEASE === undefined
        ? Effect.sync(() => record("infra:release"))
        : Effect.never,
  ),
);

export default Mitome.make({
  agent,
  provide: layer,
  providers: [scripted, oauth],
  model: "scripted/echo",
});
