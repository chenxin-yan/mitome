// Bun's async matchers are typed void but must be awaited to stay within the test.
// oxlint-disable typescript/await-thenable
import { describe, expect, test } from "bun:test";
import { Effect, Layer, Stream } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { makeModel } from "@mitome/core";
import {
  defineAgent,
  definePlugin,
  tool,
  withSession,
  type InputSchema,
  type StandardSchema,
} from "@mitome/sdk";

const outputSchema: StandardSchema<unknown, { readonly action: string }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) =>
      typeof value === "object" && value !== null && "action" in value
        ? { value: value as { readonly action: string }, issues: undefined }
        : { issues: [{ message: "expected action" }] },
  },
};

const schema: InputSchema<{ readonly action: string }> = {
  "~standard": {
    ...outputSchema["~standard"],
    jsonSchema: {
      input: () => ({ type: "object" }),
      output: () => ({ type: "object" }),
    },
  },
};

const approvalModel = () => {
  let calls = 0;
  return {
    model: makeModel(
      Layer.effect(
        LanguageModel.LanguageModel,
        LanguageModel.make({
          generateText: () => Effect.succeed([]),
          streamText: () => {
            calls += 1;
            if (calls === 1) {
              return Stream.succeed({
                type: "tool-call" as const,
                id: "call-approval",
                name: "dangerous",
                params: { action: "delete" },
              });
            }
            return Stream.succeed({ type: "text-delta" as const, id: "done", delta: "reused" });
          },
        }),
      ),
    ),
    calls: () => calls,
  };
};

describe("@mitome/sdk Tool Approval", () => {
  test("adapts a rejected async predicate fail-closed and exposes Promise decisions", async () => {
    const fixture = approvalModel();
    let handlerCalls = 0;
    const definition = defineAgent({
      instructions: "Be concise.",
      model: fixture.model,
      plugins: [
        definePlugin({
          name: "dangerous",
          tools: [
            tool({
              name: "dangerous",
              inputSchema: schema,
              outputSchema: schema,
              needsApproval: async () => Promise.reject(new Error("predicate failed")),
              handler: async (input) => {
                handlerCalls += 1;
                return input;
              },
            }),
          ],
        }),
      ],
    });

    const events = await withSession(definition, async (session) => {
      const collected = [];
      for await (const event of session.prompt("Hi")) {
        collected.push(event);
        if (event.type === "approval-required") {
          await event.deny("declined");
          await expect(event.approve()).rejects.toMatchObject({ _tag: "ApprovalResolutionError" });
        }
      }
      return collected;
    });

    expect(handlerCalls).toBe(0);
    expect(events).toContainEqual({
      type: "tool-result",
      id: "call-approval",
      name: "dangerous",
      result: { type: "execution-denied", reason: "declined" },
      isFailure: true,
    });
  });

  test("approves through the streamed SDK event and completes the Turn", async () => {
    const fixture = approvalModel();
    let handlerCalls = 0;
    const definition = defineAgent({
      instructions: "Be concise.",
      model: fixture.model,
      plugins: [
        definePlugin({
          name: "dangerous",
          tools: [
            tool({
              name: "dangerous",
              inputSchema: schema,
              outputSchema: schema,
              needsApproval: true,
              handler: async (input) => {
                handlerCalls += 1;
                return input;
              },
            }),
          ],
        }),
      ],
    });

    const events = await withSession(definition, async (session) => {
      const collected = [];
      for await (const event of session.prompt("Hi")) {
        collected.push(event);
        if (event.type === "approval-required") await event.approve();
      }
      return collected;
    });

    expect(handlerCalls).toBe(1);
    expect(events).toContainEqual({
      type: "tool-result",
      id: "call-approval",
      name: "dangerous",
      result: { action: "delete" },
      isFailure: false,
    });
    expect(events).toContainEqual({ type: "response-complete" });
  });

  test("interrupts a pending approval and reuses the Session", async () => {
    const fixture = approvalModel();
    let handlerCalls = 0;
    const definition = defineAgent({
      instructions: "Be concise.",
      model: fixture.model,
      plugins: [
        definePlugin({
          name: "dangerous",
          tools: [
            tool({
              name: "dangerous",
              inputSchema: schema,
              outputSchema: schema,
              needsApproval: true,
              handler: async (input) => {
                handlerCalls += 1;
                return input;
              },
            }),
          ],
        }),
      ],
    });

    const events = await withSession(definition, async (session) => {
      const iterator = session.prompt("first")[Symbol.asyncIterator]();
      await iterator.next();
      const pending = await iterator.next();
      if (pending.done || pending.value.type !== "approval-required")
        throw new Error("missing approval");
      await iterator.return?.();
      await expect(pending.value.approve()).rejects.toMatchObject({
        _tag: "ApprovalResolutionError",
      });

      const next = [];
      for await (const event of session.prompt("second")) next.push(event);
      return next;
    });

    expect(handlerCalls).toBe(0);
    expect(fixture.calls()).toBe(2);
    expect(events).toEqual([
      { type: "model-output", text: "reused" },
      { type: "response-complete" },
    ]);
  });
});
