import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { LanguageModel, Prompt, Response } from "effect/unstable/ai";
import type { CompiledAgent } from "../../src/agent.js";
import { makeStepRunner } from "../../src/session/step-runner.js";
import type { ToolExecution } from "../../src/session/tool-execution.js";
import { testLanguageModel } from "../support/provider.js";

const compiled: CompiledAgent = {
  plugins: [],
  providers: new Map(),
  defaultModel: { providerId: "test", modelId: "default" },
  tools: new Map(),
  instructions: "",
};

const toolExecution = (request?: ToolExecution["approval"]["request"]): ToolExecution =>
  ({
    toolkit: { tools: {}, handle: () => Effect.succeed(Stream.empty) },
    approval: {
      request:
        request ?? (() => Effect.die("Approval was not expected") as Effect.Effect<never, never>),
      resolve: () => Effect.void,
      reset: () => undefined,
    },
  }) as ToolExecution;

const runtimeModel = (streamText: (options: { readonly prompt: Prompt.Prompt }) => unknown) =>
  Effect.gen(function* () {
    const service = testLanguageModel(streamText);
    const context = yield* Layer.build(Layer.succeed(LanguageModel.LanguageModel, service));
    return { context, model: service };
  });

describe("StepRunner", () => {
  it.effect("translates model parts into Turn events", () =>
    Effect.gen(function* () {
      const selected = yield* runtimeModel(() =>
        Stream.fromIterable([
          Response.makePart("text-delta", { id: "text", delta: "hello" }),
          Response.makePart("tool-call", {
            id: "call",
            name: "search",
            params: {},
            providerExecuted: true,
          }),
          Response.makePart("tool-result", {
            id: "call",
            name: "search",
            result: "found",
            encodedResult: "found",
            isFailure: false,
            preliminary: false,
            providerExecuted: true,
          }),
        ]),
      );
      const runner = makeStepRunner(compiled, new Map(), toolExecution());

      expect([...(yield* Stream.runCollect(runner.run(Prompt.make("Hi"), selected)))]).toEqual([
        { type: "model-output", text: "hello" },
        { type: "tool-call", id: "call", name: "search" },
        { type: "tool-result", id: "call", name: "search", result: "found", isFailure: false },
        { type: "turn-complete", history: expect.anything() },
      ]);
    }),
  );

  it.effect("recurses when a Step contains an unexecuted Tool Call", () =>
    Effect.gen(function* () {
      let calls = 0;
      const prompts: Array<Prompt.Prompt> = [];
      const selected = yield* runtimeModel(({ prompt }) => {
        calls += 1;
        prompts.push(prompt);
        return Stream.succeed(
          calls === 1
            ? Response.makePart("tool-call", {
                id: "call",
                name: "echo",
                params: {},
                providerExecuted: false,
              })
            : Response.makePart("text-delta", { id: "done", delta: "done" }),
        );
      });
      const runner = makeStepRunner(compiled, new Map(), toolExecution());

      yield* Stream.runDrain(runner.run(Prompt.make("Hi"), selected));

      expect(calls).toBe(2);
      expect(prompts[1]?.content.map((message) => message.role)).toEqual(["user", "assistant"]);
    }),
  );

  it.effect("accumulates Approval decisions into the next Step prompt", () =>
    Effect.gen(function* () {
      let calls = 0;
      let nextPrompt: Prompt.Prompt | undefined;
      const selected = yield* runtimeModel(({ prompt }) => {
        calls += 1;
        if (calls === 2) {
          nextPrompt = prompt;
          return Stream.succeed(Response.makePart("text-delta", { id: "done", delta: "done" }));
        }
        return Stream.fromIterable([
          Response.makePart("tool-call", {
            id: "call",
            name: "dangerous",
            params: { action: "delete" },
            providerExecuted: false,
          }),
          Response.makePart("tool-approval-request", {
            approvalId: "approval",
            toolCallId: "call",
          }),
        ]);
      });
      const execution = toolExecution((part, call) =>
        Effect.succeed({
          _tag: "Pending",
          id: part.approvalId,
          approvalId: part.approvalId,
          toolCallId: part.toolCallId,
          name: call.name,
          params: call.params,
          awaitDecision: Effect.succeed({ approved: false, reason: "declined" }),
        }),
      );
      const runner = makeStepRunner(compiled, new Map(), execution);

      const events = yield* Stream.runCollect(runner.run(Prompt.make("Hi"), selected));

      expect(events.some((event) => event.type === "approval-required")).toBe(true);
      expect(nextPrompt?.content.at(-1)?.role).toBe("tool");
      expect(JSON.stringify(nextPrompt)).toContain("declined");
    }),
  );
});
