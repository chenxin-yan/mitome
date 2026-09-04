import { describe, expect, test } from "vitest";
import { Effect, Layer, Result, Schema, Stream } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { makeProvider } from "@mitome/core";
import { defineAgent, defineExtension, tool, withSession, type InputSchema } from "../src/index.js";

const Action = Schema.Struct({ action: Schema.String });

const schema: InputSchema<{ readonly action: string }> = Action;

const defaultingSchema: InputSchema<{
  readonly action: string;
  readonly destructive: boolean;
}> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) =>
      Result.match(Schema.decodeUnknownResult(Action)(value), {
        onFailure: () => ({ issues: [{ message: "expected action" }] }),
        onSuccess: ({ action }) => ({
          value: { action, destructive: true },
          issues: undefined,
        }),
      }),
    jsonSchema: {
      input: () => ({ type: "object" }),
      output: () => ({ type: "object" }),
    },
  },
};

const approvalModel = () => {
  let calls = 0;
  return {
    provider: makeProvider("test", [] as const, undefined, () =>
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
      providers: [fixture.provider],
      model: "test/default",
      extensions: [
        defineExtension({
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
      for await (const event of session.runTurn("Hi")) {
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

  test("adapts a resolving async predicate with validated input", async () => {
    const fixture = approvalModel();
    let handlerCalls = 0;
    let seen: unknown;
    const definition = defineAgent({
      providers: [fixture.provider],
      model: "test/default",
      extensions: [
        defineExtension({
          name: "dangerous",
          tools: [
            tool({
              name: "dangerous",
              inputSchema: schema,
              outputSchema: schema,
              needsApproval: async (input) => {
                seen = input;
                return input.action === "delete";
              },
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
      for await (const event of session.runTurn("Hi")) {
        collected.push(event);
        if (event.type === "approval-required") await event.approve();
      }
      return collected;
    });

    expect(seen).toEqual({ action: "delete" });
    expect(handlerCalls).toBe(1);
    expect(events).toContainEqual({
      type: "tool-result",
      id: "call-approval",
      name: "dangerous",
      result: { action: "delete" },
      isFailure: false,
    });
  });

  test("exposes validated approval parameters", async () => {
    const fixture = approvalModel();
    let approvalParams: unknown;
    let handlerInput: unknown;
    const definition = defineAgent({
      providers: [fixture.provider],
      model: "test/default",
      extensions: [
        defineExtension({
          name: "dangerous",
          tools: [
            tool({
              name: "dangerous",
              inputSchema: defaultingSchema,
              outputSchema: schema,
              needsApproval: true,
              handler: async (input) => {
                handlerInput = input;
                return input;
              },
            }),
          ],
        }),
      ],
    });

    await withSession(definition, async (session) => {
      for await (const event of session.runTurn("Hi")) {
        if (event.type === "approval-required") {
          approvalParams = event.params;
          await event.approve();
        }
      }
    });

    expect(approvalParams).toEqual({ action: "delete", destructive: true });
    expect(handlerInput).toEqual(approvalParams);
  });

  test("approves through the streamed SDK event and completes the Turn", async () => {
    const fixture = approvalModel();
    let handlerCalls = 0;
    const definition = defineAgent({
      providers: [fixture.provider],
      model: "test/default",
      extensions: [
        defineExtension({
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
      for await (const event of session.runTurn("Hi")) {
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
      providers: [fixture.provider],
      model: "test/default",
      extensions: [
        defineExtension({
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
      const iterator = session.runTurn("first")[Symbol.asyncIterator]();
      await iterator.next();
      const pending = await iterator.next();
      if (pending.done || pending.value.type !== "approval-required")
        throw new Error("missing approval");
      await iterator.return?.();
      await expect(pending.value.approve()).rejects.toMatchObject({
        _tag: "ApprovalResolutionError",
        message: "Approval is no longer pending (the Turn ended or the request is missing)",
      });

      const next = [];
      for await (const event of session.runTurn("second")) next.push(event);
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
