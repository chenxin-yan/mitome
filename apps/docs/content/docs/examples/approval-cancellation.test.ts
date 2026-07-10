import { expect, test } from "bun:test";
import { Effect, Layer, Schema, Stream } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { makeModel } from "@mitome/core";
import { defineAgent, definePlugin, tool, withSession } from "@mitome/sdk";

const actionSchema = Schema.Struct({ action: Schema.String });

const approvalModel = () => {
  let calls = 0;
  return makeModel(
    Layer.effect(
      LanguageModel.LanguageModel,
      LanguageModel.make({
        generateText: () => Effect.succeed([]),
        streamText: () => {
          calls += 1;
          return calls === 1
            ? Stream.succeed({
                type: "tool-call" as const,
                id: "delete-1",
                name: "delete",
                params: { action: "delete" },
              })
            : Stream.succeed({ type: "text-delta" as const, id: "done", delta: "reused" });
        },
      }),
    ),
  );
};

const definition = () =>
  defineAgent({
    instructions: "Use delete.",
    model: approvalModel(),
    plugins: [
      definePlugin({
        name: "dangerous-tools",
        tools: [
          tool({
            name: "delete",
            inputSchema: actionSchema,
            outputSchema: actionSchema,
            needsApproval: async (input) => input.action === "delete",
            handler: async (input) => input,
          }),
        ],
      }),
    ],
  });

// #region approval
const resolveApprovals = async () => {
  await withSession(definition(), async (session) => {
    for await (const event of session.prompt("remove it")) {
      if (event.type === "approval-required") await event.deny("not today");
    }
  });
};
// #endregion approval

test("a pending Approval is single-use and early iteration cancellation leaves a reusable Session", async () => {
  await resolveApprovals();

  await withSession(definition(), async (session) => {
    const iterator = session.prompt("first")[Symbol.asyncIterator]();
    await iterator.next();
    const pending = await iterator.next();
    if (pending.done || pending.value.type !== "approval-required")
      throw new Error("missing Approval");

    const cancelled = iterator.return?.();
    if (cancelled !== undefined) await cancelled;
    try {
      await pending.value.approve();
      throw new Error("expected an expired Approval");
    } catch (error) {
      expect(error).toMatchObject({ _tag: "ApprovalResolutionError" });
    }

    const next = [];
    for await (const event of session.prompt("second")) next.push(event);
    expect(next).toEqual([{ type: "model-output", text: "reused" }, { type: "response-complete" }]);
  });
});
