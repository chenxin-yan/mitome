import { describe, expect, test } from "vitest";
import { Effect, Layer, Result, Schema, Stream } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { makeProvider } from "@mitome/core";
import { defineAgent, defineExtension, withSession, type InputSchema } from "../src/index.js";
import { defineAgent as defineEffectAgent } from "../src/effect.js";

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
          tools: ({ tool }) => [
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
          tools: ({ tool }) => [
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
    let handlerCalls = 0;
    const definition = defineAgent({
      providers: [fixture.provider],
      model: "test/default",
      extensions: [
        defineExtension({
          name: "dangerous",
          tools: ({ tool }) => [
            tool({
              name: "dangerous",
              inputSchema: defaultingSchema,
              outputSchema: schema,
              needsApproval: true,
              handler: async (input) => {
                handlerCalls += 1;
                handlerInput = input;
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
          approvalParams = event.params;
          await event.approve();
        }
      }
      return collected;
    });

    expect(approvalParams).toEqual({ action: "delete", destructive: true });
    expect(handlerInput).toEqual(approvalParams);
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

  test('forwards a Promise preTool "ask" as a policy Approval requirement', async () => {
    const fixture = approvalModel();
    let handlerCalls = 0;
    const definition = defineAgent({
      providers: [fixture.provider],
      model: "test/default",
      extensions: [
        defineExtension({
          name: "dangerous",
          tools: ({ tool }) => [
            tool({
              name: "dangerous",
              inputSchema: schema,
              outputSchema: schema,
              handler: async (input) => {
                handlerCalls += 1;
                return input;
              },
            }),
          ],
          hooks: { preTool: async ({ name }) => (name === "dangerous" ? "ask" : undefined) },
        }),
      ],
      approvals: { allow: ["*"] },
    });

    const events = await withSession(definition, async (session) => {
      const collected = [];
      for await (const event of session.runTurn("Hi")) {
        collected.push(event);
        if (event.type === "approval-required") await event.approve();
      }
      return collected;
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "approval-required",
        name: "dangerous",
        params: { action: "delete" },
        requirement: "policy",
      }),
    );
    expect(handlerCalls).toBe(1);
  });

  test("passes approvals through to the compiled Agent on both SDK surfaces", async () => {
    let handlerCalls = 0;
    const dangerous = defineExtension({
      name: "dangerous",
      tools: ({ tool }) => [
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
    });
    const unattended = defineAgent({
      providers: [approvalModel().provider],
      model: "test/default",
      extensions: [dangerous],
      approvals: { allow: ["*"] },
    });
    expect(unattended.approvals).toEqual({ allow: ["*"] });
    expect(
      defineEffectAgent({
        providers: [approvalModel().provider],
        model: "test/default",
        extensions: [dangerous],
        approvals: { allow: ["*"] },
      }).approvals,
    ).toEqual({ allow: ["*"] });

    const events = await withSession(unattended, (session) =>
      Array.fromAsync(session.runTurn("Hi")),
    );
    expect(events.some((event) => event.type === "approval-required")).toBe(false);
    expect(handlerCalls).toBe(1);

    const flagged = await withSession(
      defineAgent({
        providers: [approvalModel().provider],
        model: "test/default",
        extensions: [dangerous],
      }),
      async (session) => {
        const collected = [];
        for await (const event of session.runTurn("Hi")) {
          collected.push(event);
          if (event.type === "approval-required") await event.deny();
        }
        return collected;
      },
    );
    expect(flagged).toContainEqual(
      expect.objectContaining({ type: "approval-required", requirement: "tool" }),
    );

    const denied = await withSession(
      defineAgent({
        providers: [approvalModel().provider],
        model: "test/default",
        extensions: [dangerous],
        // `dangerous` is the only known Tool, so `params` is already its input.
        approvals: (call) => (call.params.action === "delete" ? "deny" : "allow"),
      }),
      (session) => Array.fromAsync(session.runTurn("Hi")),
    );
    expect(denied).toContainEqual({
      type: "tool-result",
      id: "call-approval",
      name: "dangerous",
      result: {
        type: "execution-denied",
        reason: 'Tool call "dangerous" is denied by the Agent\'s approval policy',
      },
      isFailure: true,
    });
    expect(handlerCalls).toBe(1);
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
          tools: ({ tool }) => [
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
