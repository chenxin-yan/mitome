import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate, Schema, Stream } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import type { CompiledAgent } from "../../src/agent.js";
import type { Extension, ToolInput, ToolInputValidator } from "../../src/extension.js";
import {
  type ApprovalRequestOutcome,
  type ToolExecution,
  makeToolExecution,
} from "../../src/session/tool-execution.js";

const pending = (
  outcome: ApprovalRequestOutcome,
): Extract<ApprovalRequestOutcome, { readonly _tag: "Pending" }> => {
  expect(outcome._tag).toBe("Pending");
  if (outcome._tag !== "Pending") throw new Error("Expected a pending Approval request");
  return outcome;
};

const prepare = (
  execution: ToolExecution,
  params: ToolInput,
  toolCallId = "call-1",
): Effect.Effect<boolean> => {
  const needsApproval = execution.toolkit.tools.dangerous!.needsApproval;
  if (!Predicate.isFunction(needsApproval)) throw new Error("Tool pipeline is not installed");
  const result = needsApproval(params, { toolCallId, messages: [] });
  return Effect.isEffect(result) ? result : Effect.succeed(result);
};

const request = (execution: ToolExecution, params: ToolInput, toolCallId = "call-1") =>
  execution.approval.request(
    { approvalId: `approval-${toolCallId}`, toolCallId },
    { name: "dangerous", params },
  );

const makeFixture = (options?: {
  readonly needsApproval?: Tool.NeedsApproval<any>;
  readonly inputValidator?: ToolInputValidator;
  readonly preTool?: Extension["hooks"] extends infer Hooks
    ? Hooks extends { readonly preTool?: infer PreTool }
      ? PreTool
      : never
    : never;
}) => {
  let handlerCalls = 0;
  let postCalls = 0;
  let preToolCalls = 0;
  const dangerous = Tool.make("dangerous", {
    parameters: Schema.Struct({
      action: Schema.String,
      destructive: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
    }),
    success: Schema.String,
    needsApproval: options?.needsApproval ?? true,
  });
  const extension: Extension = {
    name: "dangerous",
    toolkit: Toolkit.make(dangerous),
    handlers: {},
    hooks: {
      preTool: (context) =>
        Effect.sync(() => {
          preToolCalls += 1;
          return context;
        }).pipe(Effect.flatMap(() => options?.preTool?.(context) ?? Effect.void)),
      postTool: (context) =>
        Effect.sync(() => {
          postCalls += 1;
          return context.result;
        }),
    },
  };
  const compiled: CompiledAgent = {
    extensions: [extension],
    providers: new Map(),
    tools: new Map([
      [
        dangerous.name,
        {
          tool: dangerous,
          owner: extension,
          handler: () =>
            Effect.sync(() => {
              handlerCalls += 1;
              return "executed";
            }),
          inputValidator: options?.inputValidator,
          resultValidator: undefined,
          failureValidator: undefined,
        },
      ],
    ]),
    instructions: "",
  };
  return {
    execution: makeToolExecution(compiled, new Map()),
    counts: () => ({ handlerCalls, postCalls, preToolCalls }),
  };
};

const execute = (execution: ToolExecution, params: ToolInput, toolCallId = "call-1") =>
  execution.toolkit.handle("dangerous", params, toolCallId).pipe(Effect.flatMap(Stream.runCollect));

describe("ToolExecution", () => {
  it.effect("resolves a cancelled pending Approval with the ensuring fallback", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const execution = yield* fixture.execution;
      const params = { action: "delete" };
      yield* prepare(execution, params);
      const approval = pending(yield* request(execution, params));

      yield* Effect.timeoutOption(approval.awaitDecision, 0);

      expect(
        yield* Effect.flip(execution.approval.resolve(approval.approvalId, { approved: true })),
      ).toMatchObject({ _tag: "ApprovalResolutionError" });
      expect(fixture.counts()).toEqual({ handlerCalls: 0, postCalls: 0, preToolCalls: 1 });
    }),
  );

  it.effect("vetoes a Tool Call before requesting Approval, including an empty reason", () =>
    Effect.gen(function* () {
      for (const reason of ["vetoed", ""]) {
        const fixture = makeFixture({ preTool: () => Effect.succeed({ reason }) });
        const execution = yield* fixture.execution;
        const params = { action: "delete" };

        expect(yield* prepare(execution, params)).toBe(true);
        expect(yield* request(execution, params)).toEqual({ _tag: "Veto", reason });
        expect(fixture.counts()).toEqual({ handlerCalls: 0, postCalls: 0, preToolCalls: 1 });
      }
    }),
  );

  it.effect("discards prepared Tool Call state when Approval is denied", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const execution = yield* fixture.execution;
      const params = { action: "delete" };
      yield* prepare(execution, params);
      const approval = pending(yield* request(execution, params));

      yield* execution.approval.resolve(approval.approvalId, {
        approved: false,
        reason: "declined",
      });
      expect(yield* approval.awaitDecision).toEqual({ approved: false, reason: "declined" });
      yield* execute(execution, params);

      expect(fixture.counts()).toEqual({ handlerCalls: 1, postCalls: 1, preToolCalls: 2 });
    }),
  );

  it.effect("resets prepared Tool Call state between Turns", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({ needsApproval: false });
      const execution = yield* fixture.execution;
      const params = { action: "delete" };
      expect(yield* prepare(execution, params)).toBe(false);

      execution.approval.reset();
      yield* execute(execution, params);

      expect(fixture.counts()).toEqual({ handlerCalls: 1, postCalls: 1, preToolCalls: 2 });
    }),
  );

  it.effect("evaluates dynamic Approval predicates against prepared Tool input", () =>
    Effect.gen(function* () {
      const requiresApproval = makeFixture({
        needsApproval: (params: { readonly action: string }) => params.action === "delete",
      });
      const gated = yield* requiresApproval.execution;
      const params = { action: "delete" };
      expect(yield* prepare(gated, params)).toBe(true);
      const approval = pending(yield* request(gated, params));
      expect(requiresApproval.counts()).toEqual({
        handlerCalls: 0,
        postCalls: 0,
        preToolCalls: 1,
      });
      yield* gated.approval.resolve(approval.approvalId, { approved: true });
      yield* approval.awaitDecision;
      yield* execute(gated, params);
      expect(requiresApproval.counts()).toEqual({
        handlerCalls: 1,
        postCalls: 1,
        preToolCalls: 1,
      });

      const immediate = makeFixture({
        needsApproval: (input: { readonly action: string }) => input.action !== "delete",
      });
      const ungated = yield* immediate.execution;
      expect(yield* prepare(ungated, params)).toBe(false);
      yield* execute(ungated, params);
      expect(immediate.counts()).toEqual({ handlerCalls: 1, postCalls: 1, preToolCalls: 1 });
    }),
  );

  it.effect("fails closed when a dynamic Approval predicate throws", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({
        needsApproval: () => {
          throw new Error("predicate threw");
        },
      });
      const execution = yield* fixture.execution;
      const params = { action: "delete" };
      expect(yield* prepare(execution, params)).toBe(true);
      const approval = pending(yield* request(execution, params));
      expect(fixture.counts()).toEqual({ handlerCalls: 0, postCalls: 0, preToolCalls: 1 });
      yield* execution.approval.resolve(approval.approvalId, {
        approved: false,
        reason: "declined",
      });
      expect(
        yield* Effect.flip(execution.approval.resolve(approval.approvalId, { approved: true })),
      ).toMatchObject({ _tag: "ApprovalResolutionError" });
      expect(yield* approval.awaitDecision).toEqual({
        approved: false,
        reason: "declined",
      });
      expect(fixture.counts()).toEqual({ handlerCalls: 0, postCalls: 0, preToolCalls: 1 });
    }),
  );

  it.effect(
    "correlates decoded and raw input by Tool Call id without rerunning pre-Tool Hooks",
    () =>
      Effect.gen(function* () {
        const cases = [
          {
            prepared: { action: "delete", destructive: false },
            raw: { destructive: false, action: "delete" },
          },
          {
            prepared: { action: "delete", destructive: true },
            raw: { action: "delete" },
          },
        ];
        for (const [index, current] of cases.entries()) {
          const fixture = makeFixture({ needsApproval: false });
          const execution = yield* fixture.execution;
          const toolCallId = `call-${index}`;

          expect(yield* prepare(execution, current.prepared, toolCallId)).toBe(false);
          yield* execute(execution, current.raw, toolCallId);

          expect(fixture.counts()).toEqual({ handlerCalls: 1, postCalls: 1, preToolCalls: 1 });
        }
      }),
  );
});
