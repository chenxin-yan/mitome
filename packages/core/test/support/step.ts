import { Effect, Layer, Stream } from "effect";
import { type AiError, LanguageModel, type Response } from "effect/ai";
import { reportModelRequest, withModelRequestAccounting } from "../../src/index.js";

/** One scripted generation: encoded response parts, or a native failure. */
export type Script = Array<
  ReadonlyArray<Response.PartEncoded> | Effect.Effect<never, AiError.AiError>
>;

export const call = (id: string, name: string, key = id): Response.ToolCallPartEncoded => ({
  type: "tool-call",
  id,
  name,
  params: { key },
});

export const text = (value: string): Response.TextPartEncoded => ({ type: "text", text: value });

export const finish = (reason: Response.FinishReason): Response.FinishPartEncoded => ({
  type: "finish",
  reason,
  usage: { inputTokens: {}, outputTokens: {} },
});

export const remoteCall = (id: string, name: string): Response.ToolCallPartEncoded => ({
  type: "tool-call",
  id,
  name,
  params: { key: id },
  providerExecuted: true,
});

export const remoteResult = (id: string, name: string): Response.ToolResultPartEncoded => ({
  type: "tool-result",
  id,
  name,
  result: "remote",
  isFailure: false,
  providerExecuted: true,
});

/**
 * A bare scripted native `LanguageModel.make` Model, without a request-accounting declaration;
 * each generation logs `generate:<prompt length>` and reports `requests` physical requests.
 */
export const scriptedLanguageModel = (script: Script, log: Array<string>, requests = 1) =>
  Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: (options) =>
        Effect.gen(function* () {
          log.push(`generate:${options.prompt.content.length}`);
          for (let i = 0; i < requests; i++) yield* reportModelRequest;
          const next = script.shift();
          if (next === undefined) return yield* Effect.die(new Error("script exhausted"));
          if (Effect.isEffect(next)) return yield* next;
          return [...next];
        }),
      streamText: () => Stream.die(new Error("not streamed")),
    }),
  );

/** The scripted Model with its own request-accounting declaration, as a qualified binding. */
export const scriptedModel = (script: Script, log: Array<string>, requests = 1) =>
  withModelRequestAccounting("scripted", scriptedLanguageModel(script, log, requests));
