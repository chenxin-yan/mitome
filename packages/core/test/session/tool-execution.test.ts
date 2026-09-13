import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate, Schema, Stream } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import type { ApprovalPolicy, ApprovalPolicyCall, CompiledAgent } from "../../src/agent.js";
import { compileAgentDefinition } from "../../src/agent.js";
import type {
  Extension,
  ExtensionHooks,
  ToolInput,
  ToolInputValidator,
} from "../../src/extension.js";
import {
  type ApprovalRequestOutcome,
  type ToolExecution,
  makeToolExecution,
} from "../../src/session/tool-execution.js";
import { makeTestProvider } from "../support/provider.js";

const provider = makeTestProvider(() => Stream.empty);

const pending = (
  outcome: ApprovalRequestOutcome,
): Extract<ApprovalRequestOutcome, { readonly _tag: "Pending" }> => {
  expect(outcome._tag).toBe("Pending");
  if (!Predicate.isTagged(outcome, "Pending")) {
    throw new Error("Expected a pending Approval request");
  }
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
  readonly preTool?: ExtensionHooks["preTool"];
  // Unknown so contract-violating callbacks reach compileAgentDefinition's boundary like any input.
  readonly approvals?: typeof Schema.Unknown.Type;
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
    approvals: undefined,
  };
  return {
    // Route approvals through compileAgentDefinition so the fixture exercises the compiled rule form.
    execution: Effect.flatMap(
      compileAgentDefinition({
        providers: [provider],
        model: "test/default",
        extensions: [],
        approvals: options?.approvals,
      }),
      (agent) => makeToolExecution({ ...compiled, approvals: agent.approvals }, new Map()),
    ),
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

describe("ToolExecution Approval policy merge", () => {
  const params = { action: "delete" };
  const denied = `Tool call "dangerous" is denied by the Agent's approval policy`;

  it.effect("allow skips the Tool's own needsApproval; unlisted Tools keep it", () =>
    Effect.gen(function* () {
      const allowed = makeFixture({ approvals: { allow: ["dangerous"] } });
      const execution = yield* allowed.execution;
      expect(yield* prepare(execution, params)).toBe(false);
      yield* execute(execution, params);
      expect(allowed.counts()).toEqual({ handlerCalls: 1, postCalls: 1, preToolCalls: 1 });

      const unlisted = makeFixture({ approvals: { allow: ["other"] } });
      const gated = yield* unlisted.execution;
      expect(yield* prepare(gated, params)).toBe(true);
      expect(pending(yield* request(gated, params)).requirement).toBe("tool");
    }),
  );

  it.effect("ask forces a policy Approval on an unflagged Tool", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({ needsApproval: false, approvals: { ask: ["dangerous"] } });
      const execution = yield* fixture.execution;
      expect(yield* prepare(execution, params)).toBe(true);
      expect(pending(yield* request(execution, params)).requirement).toBe("policy");
      expect(fixture.counts()).toEqual({ handlerCalls: 0, postCalls: 0, preToolCalls: 1 });
    }),
  );

  it.effect("deny patterns veto with a stable reason the Model sees", () =>
    Effect.gen(function* () {
      for (const approvals of [
        { deny: ["dangerous"] },
        { deny: ["dang*"] },
        { deny: ["*"] },
      ] satisfies ReadonlyArray<ApprovalPolicy>) {
        const fixture = makeFixture({ needsApproval: false, approvals });
        const execution = yield* fixture.execution;
        expect(yield* prepare(execution, params)).toBe(true);
        expect(yield* request(execution, params)).toEqual({ _tag: "Veto", reason: denied });
        expect(fixture.counts()).toEqual({ handlerCalls: 0, postCalls: 0, preToolCalls: 1 });
      }

      const unmatched = makeFixture({ needsApproval: false, approvals: { deny: ["dangerous_*"] } });
      const execution = yield* unmatched.execution;
      expect(yield* prepare(execution, params)).toBe(false);
    }),
  );

  it.effect("resolves overlapping rules deny > ask > allow regardless of order", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<{ approvals: ApprovalPolicy; expected: string }> = [
        { approvals: { allow: ["*"], ask: ["dangerous"], deny: ["dang*"] }, expected: "deny" },
        { approvals: { deny: ["dang*"], ask: ["dangerous"], allow: ["*"] }, expected: "deny" },
        { approvals: { allow: ["dangerous"], ask: ["*"] }, expected: "ask" },
        { approvals: { ask: ["*"], allow: ["dangerous"] }, expected: "ask" },
      ];
      for (const current of cases) {
        const fixture = makeFixture({ needsApproval: false, approvals: current.approvals });
        const execution = yield* fixture.execution;
        expect(yield* prepare(execution, params)).toBe(true);
        const outcome = yield* request(execution, params);
        if (current.expected === "deny") {
          expect(outcome).toEqual({ _tag: "Veto", reason: denied });
        } else {
          expect(pending(outcome).requirement).toBe("policy");
        }
      }
    }),
  );

  it.effect("an Extension ask beats an Agent allow while a veto short-circuits the policy", () =>
    Effect.gen(function* () {
      let policyCalls = 0;
      const asked = makeFixture({
        preTool: () => Effect.succeed("ask" as const),
        approvals: () => {
          policyCalls += 1;
          return "allow";
        },
      });
      const askExecution = yield* asked.execution;
      expect(yield* prepare(askExecution, params)).toBe(true);
      expect(pending(yield* request(askExecution, params)).requirement).toBe("policy");
      expect(policyCalls).toBe(1);

      const vetoed = makeFixture({
        preTool: () => Effect.succeed({ reason: "vetoed" }),
        approvals: () => {
          policyCalls += 1;
          return "allow";
        },
      });
      const vetoExecution = yield* vetoed.execution;
      expect(yield* prepare(vetoExecution, params)).toBe(true);
      expect(yield* request(vetoExecution, params)).toEqual({ _tag: "Veto", reason: "vetoed" });
      expect(policyCalls).toBe(1);
    }),
  );

  it.effect(
    "calls the synchronous callback once per Tool Call and lets undefined fall through",
    () =>
      Effect.gen(function* () {
        const calls: Array<unknown> = [];
        const fixture = makeFixture({
          approvals: (call: ApprovalPolicyCall) => {
            calls.push(call);
            return undefined;
          },
        });
        const execution = yield* fixture.execution;
        expect(yield* prepare(execution, params, "call-7")).toBe(true);
        const approval = pending(yield* request(execution, params, "call-7"));
        expect(approval.requirement).toBe("tool");
        yield* execution.approval.resolve(approval.approvalId, { approved: true });
        yield* approval.awaitDecision;
        yield* execute(execution, params, "call-7");

        expect(calls).toEqual([{ name: "dangerous", params, toolCallId: "call-7" }]);
        expect(fixture.counts()).toEqual({ handlerCalls: 1, postCalls: 1, preToolCalls: 1 });
      }),
  );

  it.effect("fails the Turn without running the handler on a throwing or invalid callback", () =>
    Effect.gen(function* () {
      const thrown = new Error("secret detail");
      const cases: ReadonlyArray<{ approvals: typeof Schema.Unknown.Type; cause: unknown }> = [
        {
          approvals: () => {
            throw thrown;
          },
          cause: thrown,
        },
        {
          approvals: () => Promise.resolve("allow"),
          cause: new Error("Approval policy returned an invalid decision"),
        },
        {
          approvals: () => "maybe",
          cause: new Error("Approval policy returned an invalid decision"),
        },
      ];
      for (const current of cases) {
        const fixture = makeFixture({ needsApproval: false, approvals: current.approvals });
        const execution = yield* fixture.execution;
        expect(yield* prepare(execution, params)).toBe(true);
        expect(yield* request(execution, params)).toEqual({
          _tag: "Failure",
          message: "Approval policy failed",
          cause: current.cause,
        });
        expect(fixture.counts()).toEqual({ handlerCalls: 0, postCalls: 0, preToolCalls: 1 });
      }
    }),
  );

  it.effect("reports predicate-error only when the Tool predicate is evaluated", () =>
    Effect.gen(function* () {
      let predicateCalls = 0;
      const needsApproval = () => {
        predicateCalls += 1;
        throw new Error("predicate threw");
      };
      const evaluated = makeFixture({ needsApproval });
      const execution = yield* evaluated.execution;
      expect(yield* prepare(execution, params)).toBe(true);
      expect(pending(yield* request(execution, params)).requirement).toBe("predicate-error");
      expect(predicateCalls).toBe(1);

      const allowed = makeFixture({ needsApproval, approvals: { allow: ["*"] } });
      const bypassed = yield* allowed.execution;
      expect(yield* prepare(bypassed, params)).toBe(false);
      expect(predicateCalls).toBe(1);
    }),
  );
});
