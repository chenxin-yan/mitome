import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Predicate,
  Schema,
  SchemaGetter,
  Stream,
} from "effect";
import { AiError, LanguageModel, Prompt, Response, Tool, Toolkit } from "effect/ai";
import {
  type ApprovalRequest,
  Approver,
  type ApproverService,
  ExecutionLimitError,
  IncompleteStepError,
  ModelRequestAccounting,
  Provider,
  StepProtocolError,
  ToolRegistrationError,
  Turn,
  withModelRequestAccounting,
  type CompleteStep,
  type ExecutionLimits,
  type StepResult,
  type ToolCallRequest,
} from "../../src/index.js";
import { localTools, loop, Session, step, type StepOptions } from "../../src/kernel.js";
import {
  call,
  finish,
  remoteCall,
  remoteResult,
  type Script,
  scriptedLanguageModel,
  scriptedModel,
  text,
} from "../support/step.js";

class Approvals extends Context.Service<Approvals, { readonly allowed: ReadonlySet<string> }>()(
  "test/Approvals",
) {}

class Quota extends Schema.TaggedError<Quota, { readonly brand: unique symbol }>()("Quota", {}) {}

const Write = Tool.make("write", {
  parameters: Schema.Struct({ key: Schema.String }),
  success: Schema.String,
  failure: Quota,
});
const Read = Tool.make("read", {
  parameters: Schema.Struct({ key: Schema.String }),
  success: Schema.String,
});
const Soft = Tool.make("soft", {
  parameters: Schema.Struct({ key: Schema.String }),
  success: Schema.String,
  failureMode: "return",
});
const Tools = Toolkit.make(Write, Read, Soft);

/** Request accounting declared for a different Model instance than any binding in use. */
const foreignAccounting = Layer.effect(
  ModelRequestAccounting,
  Effect.map(
    LanguageModel.make({
      generateText: () => Effect.die(new Error("unused")),
      streamText: () => Stream.die(new Error("unused")),
    }),
    (model) => ({ binding: "other", model }),
  ),
);

function assertComplete<Tools extends Record<string, Tool.Any>>(
  result: StepResult<Tools>,
): asserts result is CompleteStep<Tools> {
  if (!Predicate.isTagged(result, "Complete")) throw new Error("expected a complete Step");
}

const handlers = (log: Array<string>, hold?: Deferred.Deferred<void>) =>
  Tools.of({
    write: ({ key }) =>
      Effect.gen(function* () {
        log.push(`write:${key}:start`);
        if (key === "quota") return yield* new Quota();
        if (key === "defect") return yield* Effect.die(new Error("boom"));
        if (hold !== undefined) yield* Deferred.await(hold);
        log.push(`write:${key}:end`);
        return `wrote ${key}`;
      }).pipe(Effect.ensuring(Effect.sync(() => void log.push(`write:${key}:cleanup`)))),
    read: ({ key }) => Effect.sync(() => (log.push(`read:${key}`), `read ${key}`)),
    soft: ({ key }) => Effect.sync(() => (log.push(`soft:${key}`), `soft ${key}`)),
  });

const turnOf = <A, E, R, ME = never>(
  program: Effect.Effect<A, E, R>,
  model: Layer.Layer<LanguageModel.LanguageModel | ModelRequestAccounting, ME>,
  limits?: ExecutionLimits,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* Session.make(
        limits === undefined ? { transcript: "none" } : { transcript: "none", limits },
      );
      const exit = yield* Effect.exit(session.run(program.pipe(Effect.provide(model))));
      const [turn] = yield* session.turns;
      return { exit, history: yield* session.history, entries: turn?.entries ?? [] };
    }),
  );

const user = (value: string) =>
  Effect.gen(function* () {
    const turn = yield* Turn;
    yield* turn.stage(Prompt.userMessage({ content: [Prompt.textPart({ text: value })] }));
  });

const turnUsage = Effect.gen(function* () {
  const turn = yield* Turn;
  return yield* turn.usage;
});

describe("controlled Step", () => {
  it.effect("runs two local Tool Calls serially through the default loop, one Entry a Step", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const model = scriptedModel(
        [
          [call("c1", "write"), call("c2", "read"), finish("tool-calls")],
          [text("done"), finish("stop")],
        ],
        log,
      );
      const program = Effect.gen(function* () {
        const tools = yield* localTools(Tools, handlers(log));
        yield* user("go");
        const final = yield* loop({ tools });
        return { final, usage: yield* turnUsage };
      });
      const { exit, history, entries } = yield* turnOf(program, model);
      const { final, usage } = yield* exit;
      expect(final._tag).toBe("Complete");
      expect(final.response.text).toBe("done");
      expect(log).toEqual([
        "generate:1",
        "write:c1:start",
        "write:c1:end",
        "write:c1:cleanup",
        "read:c2",
        "generate:3",
      ]);
      expect(usage).toEqual({ generations: 2, dispatches: 2, physicalRequests: 2 });
      expect(history.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "tool",
        "assistant",
      ]);
      expect(entries).toHaveLength(2);
    }),
  );

  it.effect("keeps the original response apart from separately resolved local results", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const parts = [call("c1", "read"), finish("tool-calls")];
      const model = scriptedModel([parts, [text("ok")]], log);
      const program = Effect.gen(function* () {
        const tools = yield* localTools(Tools, handlers(log));
        const first = yield* step({ tools });
        const second = yield* step({ tools });
        return { first, second };
      });
      const { exit } = yield* turnOf(program, model);
      const { first, second } = yield* exit;
      assertComplete(first);
      expect(first.response.toolCalls.map((part) => part.id)).toEqual(["c1"]);
      expect(first.response.toolResults).toEqual([]);
      expect(first.results.map((part) => [part.id, part.name, part.result])).toEqual([
        ["c1", "read", "read c1"],
      ]);
      // Missing finish metadata is accepted after normal validation.
      expect(second._tag).toBe("Complete");
    }),
  );

  it.effect(
    "returns explicit incomplete output without dispatch or staging, and the loop fails",
    () =>
      Effect.gen(function* () {
        for (const reason of ["length", "unknown", "other", "content-filter", "error"] as const) {
          const log: Array<string> = [];
          const custom = Effect.gen(function* () {
            const tools = yield* localTools(Tools, handlers(log));
            return yield* step({ tools });
          });
          const incomplete = [call("c1", "write"), finish(reason)];
          const { exit, history } = yield* turnOf(custom, scriptedModel([incomplete], log));
          const result = yield* exit;
          expect(result).toMatchObject({ _tag: "Incomplete", reason });
          expect(log).toEqual(["generate:0"]);
          expect(history).toEqual([]);

          const loopLog: Array<string> = [];
          const looped = Effect.gen(function* () {
            const tools = yield* localTools(Tools, handlers(loopLog));
            return yield* loop({ tools });
          });
          const failed = yield* turnOf(
            looped,
            scriptedModel([[call("c1", "write"), finish(reason)]], loopLog),
          );
          expect(failed.exit).toEqual(Exit.fail(new IncompleteStepError({ reason })));
          expect(loopLog).toEqual(["generate:0"]);
        }
      }),
  );

  it.effect("leaves an error part a native failure rather than a success", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const program = Effect.andThen(user("go"), step());
      const { exit, history } = yield* turnOf(
        program,
        // A misbehaving binding: generateText has no error part, so native decoding rejects it.
        scriptedModel(
          [JSON.parse('[{"type":"text","text":"partial"},{"type":"error","error":"x"}]')],
          log,
        ),
      );
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
      expect(AiError.isAiError(error) && error.reason._tag).toBe("InvalidOutputError");
      expect(history).toEqual([]);
    }),
  );

  it.effect("rejects malformed or unsupported responses before any local Tool runs", () =>
    Effect.gen(function* () {
      const cases: Array<[ReadonlyArray<Response.PartEncoded>, StepProtocolError["reason"]]> = [
        [[call("c1", "write"), call("c1", "read"), finish("tool-calls")], "malformed-response"],
        [[call("c1", "write"), finish("stop"), finish("length")], "malformed-response"],
        [[finish("tool-calls")], "malformed-response"],
        // A forged result for the local call, and a result naming another Tool.
        [[call("c1", "write"), remoteResult("c1", "write")], "malformed-response"],
        [[call("c1", "write"), remoteResult("c1", "read")], "malformed-response"],
        // A Provider-executed group, complete or unresolved, can only name a local Tool here.
        [[remoteCall("p1", "write"), remoteResult("p1", "write")], "malformed-response"],
        [[remoteCall("p1", "write"), finish("tool-calls")], "malformed-response"],
        // Contradictory data stays malformed even when the finish reports incompleteness.
        [[call("c1", "write"), call("c1", "write"), finish("length")], "malformed-response"],
        [[call("c1", "write"), finish("pause")], "unsupported-continuation"],
        [
          [
            call("c1", "write"),
            { type: "tool-approval-request", approvalId: "a", toolCallId: "c1" },
          ],
          "unsupported-continuation",
        ],
      ];
      for (const [parts, reason] of cases) {
        const log: Array<string> = [];
        const program = Effect.gen(function* () {
          const tools = yield* localTools(Tools, handlers(log));
          return yield* step({ tools });
        });
        const { exit, history } = yield* turnOf(program, scriptedModel([parts], log));
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
          _tag: "StepProtocolError",
          reason,
        });
        expect(log).toEqual(["generate:0"]);
        expect(history).toEqual([]);
      }
    }),
  );

  it.effect(
    "fails natively, without dispatch, for a Provider-executed call to an unexposed Tool",
    () =>
      Effect.gen(function* () {
        const log: Array<string> = [];
        const program = Effect.gen(function* () {
          const tools = yield* localTools(Tools, handlers(log));
          return yield* loop({ tools });
        });
        const parts = [remoteCall("p1", "web_search"), remoteResult("p1", "web_search")];
        const { exit } = yield* turnOf(program, scriptedModel([parts], log));
        const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
        expect(AiError.isAiError(error) && error.reason._tag).toBe("InvalidOutputError");
        expect(log).toEqual(["generate:0"]);
      }),
  );

  it.effect("provisions a Provider's Model only when it accounts for that Model's requests", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const accounted = Provider.make("accounted", {
        modelIds: [] as const,
        provision: () => scriptedModel([[text("ok")]], log),
      });
      const { exit } = yield* turnOf(
        Effect.andThen(step(), turnUsage),
        Provider.model(accounted, "m"),
      );
      expect(yield* exit).toEqual({ generations: 1, dispatches: 0, physicalRequests: 1 });

      // A binding without its own declaration, or declaring another Model, is refused before
      // any request.
      const bare = Provider.make("bare", {
        modelIds: [] as const,
        provision: () => scriptedLanguageModel([[text("never")]], log),
      });
      const foreign = Provider.make("foreign", {
        modelIds: [] as const,
        provision: () =>
          Layer.merge(scriptedLanguageModel([[text("never")]], log), foreignAccounting),
      });
      for (const provider of [bare, foreign]) {
        const refused = yield* turnOf(step(), Provider.model(provider, "m"));
        expect(Exit.isFailure(refused.exit) && Cause.squash(refused.exit.cause)).toMatchObject({
          _tag: "StepProtocolError",
          reason: "unsupported-accounting",
        });
      }
      expect(log).toEqual(["generate:0"]);
    }),
  );

  it.effect("refuses to generate when request accounting does not cover the Model in use", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      // A declaration for another Model instance does not cover the binding actually in use.
      const mismatched = Layer.merge(
        scriptedLanguageModel([[text("never")]], log),
        foreignAccounting,
      );
      const { exit } = yield* turnOf(
        Effect.flip(step()).pipe(Effect.zipWith(turnUsage, (error, used) => ({ error, used }))),
        mismatched,
      );
      const { error, used } = yield* exit;
      expect(error).toMatchObject({ _tag: "StepProtocolError", reason: "unsupported-accounting" });
      // No request was sent and nothing was reserved.
      expect(log).toEqual([]);
      expect(used).toEqual({ generations: 0, dispatches: 0, physicalRequests: 0 });
    }),
  );

  it.effect("rejects native approval artifacts before generation or ambient handlers", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const ambient = Tools.toLayer(handlers(log));
      const program = Effect.gen(function* () {
        const turn = yield* Turn;
        yield* turn.stage(
          Prompt.makeMessage("assistant", {
            content: [
              Prompt.makePart("tool-call", {
                id: "c1",
                name: "write",
                params: { key: "c1" },
                providerExecuted: false,
              }),
              Prompt.makePart("tool-approval-request", { approvalId: "a1", toolCallId: "c1" }),
            ],
          }),
          Prompt.makeMessage("tool", {
            content: [
              Prompt.makePart("tool-approval-response", { approvalId: "a1", approved: true }),
            ],
          }),
        );
        const tools = yield* localTools(Tools, handlers(log));
        return yield* step({ tools });
      }).pipe(Effect.provide(ambient));
      const { exit } = yield* turnOf(program, scriptedModel([[text("never")]], log));
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
        reason: "approval-artifact",
      });
      expect(log).toEqual([]);
    }),
  );

  it.effect("gates a Tool named __proto__ through its own binding, never an ambient handler", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const Proto = Tool.make("__proto__", {
        parameters: Schema.Struct({ key: Schema.String }),
        success: Schema.String,
      });
      const kit = Toolkit.make(Proto);
      const ambient = kit.toLayer({
        ["__proto__"]: () => Effect.sync(() => (log.push("ambient"), "ambient")),
      });
      const program = Effect.gen(function* () {
        const tools = yield* localTools(kit, {
          ["__proto__"]: () => Effect.sync(() => (log.push("local"), "local")),
        });
        return yield* step({ tools, policy: () => Effect.succeed("deny") });
      }).pipe(Effect.provide(ambient));
      const { exit } = yield* turnOf(program, scriptedModel([[call("c1", "__proto__")]], log));
      // The policy denial reached the gate: the call is denied as failure data.
      const result = yield* exit;
      assertComplete(result);
      expect(
        result.results.map((part) => [part.isFailure, AiError.isAiError(part.result)]),
      ).toEqual([[true, true]]);
      expect(log).toEqual(["generate:0"]);
    }),
  );

  it.effect("fails closed on denial, policy failure and a missing or refusing Approver", () =>
    Effect.gen(function* () {
      const run = (
        options: Omit<Parameters<typeof step<Toolkit.Tools<typeof Tools>>>[0] & {}, "tools">,
        approver?: ApproverService,
      ) =>
        Effect.gen(function* () {
          const log: Array<string> = [];
          const program = Effect.gen(function* () {
            const tools = yield* localTools(Tools, handlers(log));
            return yield* step({ tools, ...options });
          }).pipe(Effect.provideService(Approver, approver));
          const result = yield* turnOf(
            program,
            scriptedModel([[call("c1", "write"), call("c2", "soft")]], log),
          );
          return { ...result, log };
        });
      const ask = { policy: () => Effect.succeed("ask" as const) };
      const failing: ApproverService = {
        decide: () => Effect.fail("offline"),
      };
      const cases: ReadonlyArray<readonly [Parameters<typeof run>[0], ApproverService?]> = [
        [{ policy: () => Effect.succeed("deny" as const) }],
        [{ policy: () => Effect.fail("policy broke") }],
        [{ policy: () => Effect.die("policy defect") }],
        [ask],
        [ask, { decide: () => Effect.succeed("deny" as const) }],
        [ask, failing],
        [ask, { decide: () => Effect.die("approver defect") }],
        // Malformed results from untyped callers (here parsed JSON) deny rather than read as
        // truthy permission.
        [{ policy: () => Effect.succeed(JSON.parse('"allow "')) }],
        [ask, { decide: () => Effect.succeed(JSON.parse('"yes"')) }],
      ];
      for (const [options, approver] of cases) {
        const { exit, log } = yield* run(options, approver);
        // Both Tools, error-mode `write` included, receive the library's native AiError as failure
        // data the Model is told of, and the Step completes; no handler ran.
        const result = yield* exit;
        assertComplete(result);
        expect(result.results.map((part) => [part.name, part.isFailure])).toEqual([
          ["write", true],
          ["soft", true],
        ]);
        expect(result.results.every((part) => AiError.isAiError(part.result))).toBe(true);
        // With an ordinary failure schema the error-mode denial is encoded as the native
        // return-mode one.
        expect(result.results[0]?.encodedResult).toEqual(result.results[1]?.encodedResult);
        expect(log).toEqual(["generate:0"]);
      }
      // Return-mode Tools receive the denial as failure data and the Step completes.
      const { exit, log } = yield* run({
        policy: (request) => Effect.succeed(request.name === "soft" ? "deny" : "allow"),
      });
      const result = yield* exit;
      assertComplete(result);
      expect(result.results.map((part) => [part.name, part.isFailure])).toEqual([
        ["write", false],
        ["soft", true],
      ]);
      expect(log).toEqual(["generate:0", "write:c1:start", "write:c1:end", "write:c1:cleanup"]);
    }),
  );

  it.effect("tells the Model a denial's reason whatever the Tool's failure codec", () =>
    Effect.gen(function* () {
      const prompts: Array<Prompt.Prompt> = [];
      // A failure codec whose decoded side also accepts the denial; JSON derivation tries its
      // bigint encoding before the AiError member.
      const Code = Schema.BigInt.pipe(
        Schema.decodeTo(Schema.Unknown, {
          decode: SchemaGetter.transform((code: bigint) => code),
          encode: SchemaGetter.transform(() => 7n),
        }),
      );
      const parameters = Schema.Struct({ key: Schema.String });
      const Strict = Tool.make("strict", { parameters, success: Schema.String, failure: Code });
      const Loose = Tool.make("loose", {
        parameters,
        success: Schema.String,
        failure: Code,
        failureMode: "return",
      });
      const kit = Toolkit.make(Strict, Loose);
      const model = withModelRequestAccounting(
        "recording",
        Layer.effect(
          LanguageModel.LanguageModel,
          LanguageModel.make({
            generateText: (options) =>
              Effect.sync(() => {
                prompts.push(options.prompt);
                return prompts.length === 1
                  ? [call("c1", "strict"), call("c2", "loose"), call("c3", "loose")]
                  : [text("done")];
              }),
            streamText: () => Stream.die(new Error("not streamed")),
          }),
        ),
      );
      const program = Effect.gen(function* () {
        const tools = yield* localTools(kit, {
          strict: () => Effect.succeed("ran"),
          loose: () => Effect.fail("broken"),
        });
        const policy = (request: { readonly toolCallId: string }) =>
          Effect.succeed(request.toolCallId === "c3" ? ("allow" as const) : ("deny" as const));
        const first = yield* step({ tools, policy });
        yield* loop({ tools, policy });
        return first;
      });
      const { exit } = yield* turnOf(program, model);
      const first = yield* exit;
      assertComplete(first);
      const sent = (prompts[1]?.content ?? []).flatMap((message) =>
        message.role === "tool" ? message.content : [],
      );
      const reason = "Tool call was denied by policy";
      expect(sent.map((part) => part.type === "tool-result" && part.id)).toEqual([
        "c1",
        "c2",
        "c3",
      ]);
      // Both denials carry their reason; a handler's own failure keeps the Tool's codec.
      expect(JSON.stringify(sent[0])).toContain(reason);
      expect(JSON.stringify(sent[1])).toContain(reason);
      expect(first.results.map((part) => part.encodedResult)[2]).toEqual("7");
    }),
  );

  it.effect(
    "shows the Approver the JSON the Model sent and never dispatches once the Turn is interrupted",
    () =>
      Effect.gen(function* () {
        const log: Array<string> = [];
        const approved: Array<unknown> = [];
        const handled: Array<unknown> = [];
        const Seen = Tool.make("seen", {
          parameters: Schema.Struct({ to: Schema.URLFromString }),
          success: Schema.String,
        });
        const kit = Toolkit.make(Seen);
        const program = Effect.gen(function* () {
          const tools = yield* localTools(kit, {
            seen: ({ to }) => Effect.sync(() => (handled.push(to), log.push("seen"), "ok")),
          });
          return yield* step({ tools, policy: () => Effect.succeed("ask") }).pipe(
            Effect.provideService(Approver, {
              decide: (request) =>
                Effect.sync(() => (approved.push(request.params), "allow" as const)),
            }),
          );
        });
        const sent = { to: "https://pay.example/a?b=c" };
        const { exit } = yield* turnOf(
          program,
          scriptedModel([[{ type: "tool-call", id: "c1", name: "seen", params: sent }]], log),
        );
        yield* exit;
        // The Approver sees the string the Model sent; the handler, the URL decoded from it.
        expect(approved).toEqual([sent]);
        expect(handled).toHaveLength(1);
        expect(handled[0]).toBeInstanceOf(URL);
        expect(String(handled[0])).toBe(sent.to);

        // Interrupting the Turn while the Approver is pending never enters the handler.
        const held: Array<string> = [];
        const pending = yield* Deferred.make<"allow">();
        const waiting = yield* Deferred.make<void>();
        const interrupted = Effect.gen(function* () {
          const tools = yield* localTools(kit, {
            seen: () => Effect.sync(() => (held.push("seen"), "ok")),
          });
          return yield* step({ tools, policy: () => Effect.succeed("ask") }).pipe(
            Effect.provideService(Approver, {
              decide: () =>
                Effect.andThen(Deferred.succeed(waiting, undefined), Deferred.await(pending)),
            }),
          );
        });
        const fiber = yield* Effect.forkChild(
          turnOf(
            interrupted,
            scriptedModel([[{ type: "tool-call", id: "c1", name: "seen", params: sent }]], held),
          ),
        );
        yield* Deferred.await(waiting);
        yield* Fiber.interrupt(fiber);
        yield* Deferred.succeed(pending, "allow");
        expect(held).toEqual(["generate:0"]);
      }),
  );

  it.effect("asks for a Tool's own risk flag using its decoded parameters, failing closed", () =>
    Effect.gen(function* () {
      const Risky = Tool.make("risky", {
        parameters: Schema.Struct({
          action: Schema.String,
          destructive: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
        }),
        success: Schema.String,
        failureMode: "return",
        // Sees the decoded value, including the decoding default.
        needsApproval: (params: { readonly destructive: boolean }) => params.destructive,
      });
      const Throwing = Tool.make("throwing", {
        parameters: Schema.Struct({ action: Schema.String }),
        success: Schema.String,
        failureMode: "return",
        needsApproval: () => {
          throw new Error("predicate threw");
        },
      });
      const kit = Toolkit.make(Risky, Throwing);
      const asked: Array<string> = [];
      const ran: Array<string> = [];
      const program = Effect.gen(function* () {
        const tools = yield* localTools(kit, {
          risky: ({ action }) => Effect.sync(() => (ran.push(action), "ok")),
          throwing: ({ action }) => Effect.sync(() => (ran.push(action), "ok")),
        });
        return yield* step({ tools }).pipe(
          Effect.provideService(Approver, {
            decide: (request) =>
              Effect.sync(() => (asked.push(request.toolCallId), "allow" as const)),
          }),
        );
      });
      const parts: ReadonlyArray<Response.PartEncoded> = [
        {
          type: "tool-call",
          id: "safe",
          name: "risky",
          params: { action: "read", destructive: false },
        },
        { type: "tool-call", id: "default", name: "risky", params: { action: "delete" } },
        { type: "tool-call", id: "broken", name: "throwing", params: { action: "x" } },
      ];
      const { exit } = yield* turnOf(program, scriptedModel([parts], []));
      const result = yield* exit;
      assertComplete(result);
      // Only the defaulted destructive call asks; the throwing predicate denies without asking.
      expect(asked).toEqual(["default"]);
      expect(ran).toEqual(["read", "delete"]);
      expect(result.results.map((part) => [part.id, part.isFailure])).toEqual([
        ["safe", false],
        ["default", false],
        ["broken", true],
      ]);
    }),
  );

  it.effect("keeps a parameter decoding failure native: failure data or a typed failure", () =>
    Effect.gen(function* () {
      // The encoded side accepts any string; only decoding checks the length.
      const Short = Schema.Struct({
        key: Schema.String.pipe(
          Schema.decodeTo(Schema.String.check(Schema.isMaxLength(3)), {
            decode: SchemaGetter.passthrough(),
            encode: SchemaGetter.passthrough(),
          }),
        ),
      });
      const SoftShort = Tool.make("softShort", {
        parameters: Short,
        success: Schema.String,
        failureMode: "return",
      });
      const HardShort = Tool.make("hardShort", { parameters: Short, success: Schema.String });
      const kit = Toolkit.make(SoftShort, HardShort);
      const ran: Array<string> = [];
      const program = Effect.gen(function* () {
        const tools = yield* localTools(kit, {
          softShort: ({ key }) => Effect.sync(() => (ran.push(key), key)),
          hardShort: ({ key }) => Effect.sync(() => (ran.push(key), key)),
        });
        const soft = yield* step({ tools });
        const hard = yield* Effect.flip(step({ tools }));
        return { soft, hard };
      });
      const { exit } = yield* turnOf(
        program,
        scriptedModel(
          [[call("a", "softShort", "too long")], [call("b", "hardShort", "too long")]],
          [],
        ),
      );
      const { soft, hard } = yield* exit;
      assertComplete(soft);
      expect(soft.results.map((part) => part.isFailure)).toEqual([true]);
      expect(AiError.isAiError(hard) && hard.reason._tag).toBe("ToolParameterValidationError");
      expect(ran).toEqual([]);

      // Parameters invalid for the encoded schema fail native response decoding before dispatch.
      const encodedInvalid = yield* turnOf(
        Effect.flatMap(localTools(Tools, handlers(ran)), (tools) => step({ tools })),
        scriptedModel([[{ type: "tool-call", id: "c", name: "read", params: { key: 5 } }]], []),
      );
      const error = Exit.isFailure(encodedInvalid.exit)
        ? Cause.squash(encodedInvalid.exit.cause)
        : undefined;
      expect(AiError.isAiError(error) && error.reason._tag).toBe("InvalidOutputError");
      expect(ran).toEqual([]);
    }),
  );

  it.effect("keeps native reasoning metadata, finish and usage, and loops past sixteen Steps", () =>
    Effect.gen(function* () {
      const reasoning: Response.PartEncoded = {
        type: "reasoning",
        text: "thinking",
        metadata: { openai: { itemId: "rs-1" } },
      };
      const steps: Script = Array.from({ length: 17 }, (_, i) => [call(`c${i}`, "read")]);
      steps.unshift([
        reasoning,
        call("first", "read"),
        {
          type: "finish",
          reason: "tool-calls",
          usage: { inputTokens: { total: 7 }, outputTokens: {} },
        },
      ]);
      steps.push([text("done")]);
      const program = Effect.gen(function* () {
        const tools = yield* localTools(Tools, handlers([]));
        const first = yield* step({ tools });
        const final = yield* loop({ tools });
        return { first, final, usage: yield* turnUsage };
      });
      const { exit, history } = yield* turnOf(program, scriptedModel(steps, []));
      const { first, final, usage } = yield* exit;
      assertComplete(first);
      expect(first.response.finishReason).toBe("tool-calls");
      expect(first.response.usage.inputTokens.total).toBe(7);
      expect(first.response.reasoning.map((part) => part.metadata)).toEqual([
        { openai: { itemId: "rs-1" } },
      ]);
      expect(final.response.text).toBe("done");
      expect(usage).toEqual({ generations: 19, dispatches: 18, physicalRequests: 19 });
      const assistant = history[0];
      expect(assistant?.role).toBe("assistant");
      expect(JSON.stringify(assistant?.content)).toContain("rs-1");
    }),
  );

  it.effect("denies when policy, a restriction or the Approver throws synchronously", () =>
    Effect.gen(function* () {
      const thrown = (): never => {
        throw new Error("offline");
      };
      const cases: ReadonlyArray<StepOptions<Toolkit.Tools<typeof Tools>>> = [
        { policy: thrown },
        { restrictions: [thrown] },
        { policy: () => Effect.succeed("ask") },
      ];
      for (const options of cases) {
        const denied: Array<string> = [];
        const result = yield* turnOf(
          Effect.flatMap(localTools(Tools, handlers(denied)), (tools) =>
            step({ ...options, tools }),
          ).pipe(Effect.provideService(Approver, { decide: thrown })),
          scriptedModel([[call("c1", "soft")]], denied),
        );
        // Return-mode `soft` receives the denial as failure data; its handler never ran.
        const completed = yield* result.exit;
        assertComplete(completed);
        expect(completed.results.map((part) => part.isFailure)).toEqual([true]);
        expect(denied).toEqual(["generate:0"]);
      }
    }),
  );

  it.effect("runs serviceful policy and restrictions with the Step caller's services", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const allowed = (request: { readonly name: string }) =>
        Effect.gen(function* () {
          const approvals = yield* Approvals;
          return approvals.allowed.has(request.name);
        });
      const program = Effect.gen(function* () {
        const tools = yield* localTools(Tools, handlers(log));
        return yield* step({
          tools,
          policy: () => Effect.succeed("ask"),
          restrictions: [
            (request) => Effect.map(allowed(request), (ok) => (ok ? "allow" : "deny")),
          ],
        });
      }).pipe(
        Effect.provideService(Approvals, { allowed: new Set(["read"]) }),
        Effect.provideService(Approver, { decide: () => Effect.succeed("allow") }),
      );
      const { exit } = yield* turnOf(
        program,
        scriptedModel([[call("a", "read"), call("b", "soft")]], log),
      );
      const result = yield* exit;
      assertComplete(result);
      expect(result.results.map((part) => [part.name, part.isFailure])).toEqual([
        ["read", false],
        ["soft", true],
      ]);
      expect(log).toEqual(["generate:0", "read:a"]);
    }),
  );

  it.effect("lets restrictions tighten a decision but never loosen it, failing closed", () =>
    Effect.gen(function* () {
      const run = (options: Omit<StepOptions<Toolkit.Tools<typeof Tools>>, "tools">) =>
        Effect.gen(function* () {
          const log: Array<string> = [];
          const asked: Array<string> = [];
          // Every restriction sees the call, in order, even after an earlier one denied it.
          const ran: Array<string> = [];
          const restrictions = (options.restrictions ?? []).map(
            (restriction, index) => (request: ToolCallRequest<Toolkit.Tools<typeof Tools>>) =>
              Effect.suspend(
                () => (ran.push(`${index}:${request.toolCallId}`), restriction(request)),
              ),
          );
          const program = Effect.gen(function* () {
            const tools = yield* localTools(Tools, handlers(log));
            return yield* step({ tools, ...options, restrictions });
          }).pipe(
            Effect.provideService(Approver, {
              decide: (request) =>
                Effect.sync(() => (asked.push(request.toolCallId), "allow" as const)),
            }),
          );
          const { exit } = yield* turnOf(program, scriptedModel([[call("c1", "read")]], log));
          const result = yield* exit;
          assertComplete(result);
          return [result.results[0]?.isFailure, asked, ran];
        });
      const allow = () => Effect.succeed("allow" as const);
      const ask = () => Effect.succeed("ask" as const);
      const deny = () => Effect.succeed("deny" as const);
      const cases: ReadonlyArray<
        readonly [Omit<StepOptions<Toolkit.Tools<typeof Tools>>, "tools">, unknown]
      > = [
        [{ policy: allow, restrictions: [ask] }, [false, ["c1"], ["0:c1"]]],
        [{ policy: allow, restrictions: [ask, deny] }, [true, [], ["0:c1", "1:c1"]]],
        [{ policy: ask, restrictions: [deny, allow] }, [true, [], ["0:c1", "1:c1"]]],
        // A restriction cannot loosen policy or the Tool's own flag.
        [{ policy: deny, restrictions: [allow] }, [true, [], ["0:c1"]]],
        [{ policy: ask, restrictions: [allow] }, [false, ["c1"], ["0:c1"]]],
        [{ restrictions: [ask] }, [false, ["c1"], ["0:c1"]]],
        // A failing, dying or malformed restriction denies.
        [{ policy: allow, restrictions: [() => Effect.fail("offline")] }, [true, [], ["0:c1"]]],
        [{ policy: allow, restrictions: [() => Effect.die("broken")] }, [true, [], ["0:c1"]]],
        [
          { policy: allow, restrictions: [() => Effect.succeed(JSON.parse('"allow "'))] },
          [true, [], ["0:c1"]],
        ],
      ];
      for (const [options, expected] of cases) {
        expect(yield* run(options)).toEqual(expected);
      }
    }),
  );

  it.effect("denies an ask when nobody is present, tells the Model why and continues", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const prompts: Array<string> = [];
      const model = withModelRequestAccounting(
        "recording",
        Layer.effect(
          LanguageModel.LanguageModel,
          LanguageModel.make({
            generateText: (options) =>
              Effect.sync(() => {
                prompts.push(JSON.stringify(options.prompt.content));
                return prompts.length === 1
                  ? [call("a", "write"), call("b", "read"), finish("tool-calls")]
                  : [text("done")];
              }),
            streamText: () => Stream.die(new Error("not streamed")),
          }),
        ),
      );
      const program = Effect.gen(function* () {
        const tools = yield* localTools(Tools, handlers(log));
        return yield* loop({
          tools,
          policy: (request) => Effect.succeed(request.name === "write" ? "ask" : "allow"),
        });
      });
      const { exit } = yield* turnOf(program, model);
      const final = yield* exit;
      expect(final.response.text).toBe("done");
      // Error-mode `write` was denied without running; the Step went on to `read`.
      expect(log).toEqual(["read:b"]);
      const reason = "Tool call needs approval and nobody is present to give it";
      expect(prompts[0]).not.toContain(reason);
      expect(prompts[1]).toContain(reason);
    }),
  );

  it.effect("sends a Tool's model output in place of its result and returns the result", () =>
    Effect.gen(function* () {
      const prompts: Array<Prompt.Prompt> = [];
      const Save = Tool.make("save", {
        parameters: Schema.Struct({ key: Schema.String }),
        success: Schema.Struct({ secret: Schema.String }),
        toModelOutput: () => [Prompt.textPart({ text: "saved" })],
      });
      const SaveTools = Toolkit.make(Save);
      const model = withModelRequestAccounting(
        "recording",
        Layer.effect(
          LanguageModel.LanguageModel,
          LanguageModel.make({
            generateText: (options) =>
              Effect.sync(() => {
                prompts.push(options.prompt);
                return prompts.length === 1
                  ? [call("a", "save"), finish("tool-calls")]
                  : [text("done")];
              }),
            streamText: () => Stream.die(new Error("not streamed")),
          }),
        ),
      );
      const program = Effect.gen(function* () {
        const tools = yield* localTools(
          SaveTools,
          SaveTools.of({ save: () => Effect.succeed({ secret: "private" }) }),
        );
        const first = yield* step({ tools });
        yield* loop({ tools });
        return first;
      });
      const { exit } = yield* turnOf(program, model);
      const first = yield* exit;
      assertComplete(first);
      expect(first.results.map((part) => part.result)).toEqual([{ secret: "private" }]);
      const results = (prompts[1]?.content ?? []).flatMap((message) =>
        message.role === "tool" ? message.content : [],
      );
      expect(results).toMatchObject([
        { type: "tool-result", id: "a", modelOutput: [{ type: "text", text: "saved" }] },
      ]);
    }),
  );

  it.effect("asks an Approver provided around Session.run with the call the Model sent", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const requests: Array<ApprovalRequest> = [];
      const decided: Array<unknown> = [];
      // Only the gate reaches the Host's Approver; handlers and restrictions see nobody.
      const unseen: Array<[string, ApproverService | undefined]> = [];
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* Session.make({ transcript: "none" });
          const program = Effect.gen(function* () {
            const authored = handlers(log);
            const tools = yield* localTools(
              Tools,
              Tools.of({
                ...authored,
                write: (params) =>
                  Effect.gen(function* () {
                    unseen.push(["handler", yield* Approver]);
                    return yield* authored.write(params);
                  }),
              }),
            );
            const turn = yield* Turn;
            yield* loop({
              tools,
              policy: (request) =>
                Effect.sync(() => (decided.push(request.params), "ask" as const)),
              restrictions: [
                () =>
                  Effect.gen(function* () {
                    unseen.push(["restriction", yield* Approver]);
                    return "allow" as const;
                  }),
              ],
            });
            return turn.id;
          }).pipe(Effect.provide(scriptedModel([[call("a", "write")], [text("done")]], log)));
          return yield* session.run(program).pipe(
            Effect.provideService(Approver, {
              decide: (request) => Effect.sync(() => (requests.push(request), "allow" as const)),
            }),
          );
        }),
      );
      expect(requests).toEqual([
        { turnId: result, toolCallId: "a", name: "write", params: { key: "a" } },
      ]);
      expect(decided).toEqual([{ key: "a" }]);
      expect(log).toEqual([
        "generate:0",
        "write:a:start",
        "write:a:end",
        "write:a:cleanup",
        "generate:2",
      ]);

      // A Tool's own risk check is Tool code too.
      const Probing = Tool.make("probing", {
        parameters: Schema.Struct({ key: Schema.String }),
        success: Schema.String,
        failureMode: "return",
        needsApproval: () =>
          Effect.gen(function* () {
            unseen.push(["needsApproval", yield* Approver]);
            return true;
          }),
      });
      const probing = Effect.gen(function* () {
        const tools = yield* localTools(Toolkit.make(Probing), {
          probing: () => Effect.succeed("ok"),
        });
        return yield* step({ tools });
      }).pipe(
        Effect.provideService(Approver, {
          decide: (request) => Effect.sync(() => (requests.push(request), "allow" as const)),
        }),
      );
      const { exit } = yield* turnOf(probing, scriptedModel([[call("p", "probing")]], []));
      assertComplete(yield* exit);
      expect(requests.map((request) => request.toolCallId)).toEqual(["a", "p"]);
      expect(unseen).toEqual([
        ["restriction", undefined],
        ["handler", undefined],
        ["needsApproval", undefined],
      ]);
    }),
  );

  it.effect("runs the gate's callbacks with exactly the Step caller's context", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const seen: Array<string> = [];
      const Permission = Context.Reference<"allow" | "deny">("test/Permission", {
        defaultValue: () => "deny",
      });
      const permitted = (callback: string) =>
        Effect.gen(function* () {
          const permission = yield* Permission;
          seen.push(`${callback}:${permission}`);
          return permission;
        });
      const program = Effect.gen(function* () {
        // Set only while the Tools are registered, never around the Step.
        const tools = yield* localTools(Tools, handlers(log)).pipe(
          Effect.provideService(Permission, "allow"),
        );
        return yield* step({
          tools,
          policy: () => Effect.as(permitted("policy"), "ask" as const),
          restrictions: [() => Effect.as(permitted("restriction"), "ask" as const)],
        });
      }).pipe(
        Effect.provideService(Approver, {
          decide: () => permitted("decide"),
        }),
      );
      const { exit } = yield* turnOf(program, scriptedModel([[call("c1", "soft")]], log));
      const result = yield* exit;
      assertComplete(result);
      expect(seen).toEqual(["policy:deny", "restriction:deny", "decide:deny"]);
      expect(result.results.map((part) => part.isFailure)).toEqual([true]);
      expect(log).toEqual(["generate:0"]);
    }),
  );

  it.effect("shows the Approver the sent call and runs the handler with what policy decided", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const approved: Array<unknown> = [];
      const handled: Array<unknown> = [];
      const program = Effect.gen(function* () {
        const authored = handlers(log);
        const tools = yield* localTools(
          Tools,
          Tools.of({
            ...authored,
            read: (params) => Effect.suspend(() => (handled.push(params), authored.read(params))),
          }),
        );
        return yield* step({
          tools,
          policy: () => Effect.succeed("ask"),
          restrictions: [
            (request) =>
              Effect.sync(() => {
                Reflect.set(request, "params", { key: "swapped" });
                return "allow" as const;
              }),
          ],
        });
      }).pipe(
        Effect.provideService(Approver, {
          decide: (request) => Effect.sync(() => (approved.push(request.params), "allow" as const)),
        }),
      );
      const { exit } = yield* turnOf(program, scriptedModel([[call("c1", "read")]], log));
      const result = yield* exit;
      assertComplete(result);
      expect(approved).toEqual([{ key: "c1" }]);
      expect(handled).toEqual([{ key: "c1" }]);
    }),
  );

  it.effect("rejects a response whose Tool Call parameters are not JSON before asking anyone", () =>
    Effect.gen(function* () {
      const asked: Array<unknown> = [];
      const handled: Array<unknown> = [];
      // `Schema.Any` lets a value through that the Model contract says is JSON.
      const Loose = Tool.make("loose", {
        parameters: Schema.Struct({ value: Schema.Any }),
        success: Schema.String,
      });
      const program = Effect.gen(function* () {
        const tools = yield* localTools(Toolkit.make(Loose), {
          loose: (params) => Effect.sync(() => (handled.push(params), "ok")),
        });
        return yield* step({ tools, policy: () => Effect.succeed("ask") }).pipe(
          Effect.provideService(Approver, {
            decide: (request) => Effect.sync(() => (asked.push(request), "allow" as const)),
          }),
        );
      });
      for (const value of [new Date(0), Infinity]) {
        const parts: ReadonlyArray<Response.PartEncoded> = [
          { type: "tool-call", id: "c1", name: "loose", params: { value } },
        ];
        const { exit } = yield* turnOf(program, scriptedModel([parts], []));
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
          _tag: "StepProtocolError",
          reason: "malformed-response",
        });
      }
      expect(asked).toEqual([]);
      expect(handled).toEqual([]);
    }),
  );

  it.effect(
    "shows the Approver, dispatches and keeps one copy of Tool Call parameters, as a store reads it back",
    () =>
      Effect.gen(function* () {
        const Loose = Tool.make("loose", {
          parameters: Schema.Struct({ value: Schema.Any }),
          success: Schema.String,
        });
        // A custom Provider can hand over values that a store would read back as something else:
        // each reaches the Approver, the handler and the conversation as the JSON copy kept of it.
        const hooked = { target: "/etc/passwd" };
        Object.defineProperty(hooked, "toJSON", {
          enumerable: false,
          value: () => ({ target: "/tmp/harmless" }),
        });
        const inherited = Object.setPrototypeOf(["/etc/passwd"], {
          toJSON: () => ["/tmp/harmless"],
        });
        const accessor = {
          get target() {
            return "/tmp/harmless";
          },
        };
        const hidden = Object.defineProperty({ target: "/tmp/harmless" }, "also", {
          enumerable: false,
          value: "/etc/passwd",
        });
        const keyed = { target: "/tmp/harmless", [Symbol.for("also")]: "/etc/passwd" };
        const extra = Object.assign(["/tmp/harmless"], { also: "/etc/passwd" });
        // Array indices stop at 2 ** 32 - 2, so this key is an ordinary property outside `length`.
        const unindexed = Object.assign(["/tmp/harmless"], { "4294967295": "/etc/passwd" });
        // A field that is only named `toJSON` is ordinary data.
        const named = { toJSON: "text" };
        for (const [value, copy] of [
          [hooked, { target: "/etc/passwd" }],
          [inherited, ["/etc/passwd"]],
          [accessor, { target: "/tmp/harmless" }],
          [hidden, { target: "/tmp/harmless" }],
          [keyed, { target: "/tmp/harmless" }],
          [extra, ["/tmp/harmless"]],
          [unindexed, ["/tmp/harmless"]],
          [named, named],
        ] as const) {
          const asked: Array<unknown> = [];
          const handled: Array<unknown> = [];
          const program = Effect.gen(function* () {
            const tools = yield* localTools(Toolkit.make(Loose), {
              loose: (params) => Effect.sync(() => (handled.push(params), "ok")),
            });
            return yield* step({ tools, policy: () => Effect.succeed("ask") }).pipe(
              Effect.provideService(Approver, {
                decide: (request) =>
                  Effect.sync(() => (asked.push(request.params), "allow" as const)),
              }),
            );
          });
          const parts: ReadonlyArray<Response.PartEncoded> = [
            { type: "tool-call", id: "c1", name: "loose", params: { value } },
          ];
          const { exit, history } = yield* turnOf(program, scriptedModel([parts], []));
          assertComplete(yield* exit);
          expect(asked).toStrictEqual([{ value: copy }]);
          expect(handled).toStrictEqual([{ value: copy }]);
          const kept = history[0]?.content[0];
          expect(Predicate.hasProperty(kept, "params") ? kept.params : undefined).toStrictEqual({
            value: copy,
          });
        }
      }),
  );

  it.effect("denies a call whose decoded arguments a restriction tries to change", () =>
    Effect.gen(function* () {
      const handled: Array<ReadonlyArray<string>> = [];
      const Send = Tool.make("send", {
        parameters: Schema.Struct({ to: Schema.mutable(Schema.Array(Schema.String)) }),
        success: Schema.String,
      });
      const kit = Toolkit.make(Send);
      const send = (
        restrictions: NonNullable<StepOptions<Toolkit.Tools<typeof kit>>["restrictions"]>,
      ): Effect.Effect<unknown> =>
        Effect.gen(function* () {
          const program = Effect.gen(function* () {
            const tools = yield* localTools(kit, {
              send: ({ to }) => Effect.sync(() => (handled.push(to), "sent")),
            });
            return yield* step({ tools, policy: () => Effect.succeed("allow"), restrictions });
          });
          const sent: Response.ToolCallPartEncoded = {
            type: "tool-call",
            id: "c1",
            name: "send",
            params: { to: ["alice"] },
          };
          const { exit } = yield* turnOf(program, scriptedModel([[sent]], []));
          const result = yield* exit;
          assertComplete(result);
          return result.results.map((part) => part.isFailure);
        }).pipe(Effect.orDie);
      // The mutation throws, so the restriction fails closed and the handler never runs.
      expect(
        yield* send([
          (request) => Effect.sync(() => (request.params.to.push("mallory"), "allow" as const)),
        ]),
      ).toEqual([true]);
      expect(handled).toEqual([]);
      // The handler receives the same frozen value the callbacks saw.
      expect(yield* send([])).toEqual([false]);
      expect(handled).toEqual([["alice"]]);
      expect(Object.isFrozen(handled[0])).toBe(true);
    }),
  );

  it.effect("propagates a defect that follows a denial instead of recording the denial", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const Fragile = Tool.make("fragile", {
        parameters: Schema.Struct({ key: Schema.String }),
        success: Schema.String,
      });
      let denying = false;
      // Native handling reads the failure mode after the gate failed; that read dies here.
      Object.defineProperty(Fragile, "failureMode", {
        get: () => {
          if (denying) throw new Error("after the denial");
          return "error";
        },
      });
      const kit = Toolkit.make(Fragile);
      const program = Effect.gen(function* () {
        const tools = yield* localTools(kit, { fragile: () => Effect.succeed("ran") });
        return yield* step({
          tools,
          policy: () => Effect.sync(() => ((denying = true), "deny" as const)),
        });
      });
      const { exit } = yield* turnOf(program, scriptedModel([[call("c1", "fragile")]], log));
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
      expect(String(Cause.squash(Exit.isFailure(exit) ? exit.cause : Cause.empty))).toContain(
        "after the denial",
      );
    }),
  );

  it.effect("prepends Instructions to the Model Context without staging them", () =>
    Effect.gen(function* () {
      const prompts: Array<ReadonlyArray<string>> = [];
      const model = withModelRequestAccounting(
        "recording",
        Layer.effect(
          LanguageModel.LanguageModel,
          LanguageModel.make({
            generateText: (options) =>
              Effect.andThen(
                Effect.sync(() => prompts.push(options.prompt.content.map((m) => m.role))),
                Effect.succeed([text("ok")]),
              ),
            streamText: () => Stream.die(new Error("not streamed")),
          }),
        ),
      );
      const { exit, history } = yield* turnOf(
        Effect.andThen(user("go"), step({ instructions: "Be brief." })),
        model,
      );
      yield* exit;
      expect(prompts).toEqual([["system", "user"]]);
      expect(history.map((message) => message.role)).toEqual(["user", "assistant"]);
    }),
  );

  it.effect(
    "propagates a later Tool's typed failure after an earlier effect, committing nothing",
    () =>
      Effect.gen(function* () {
        const log: Array<string> = [];
        const program = Effect.gen(function* () {
          const tools = yield* localTools(Tools, handlers(log));
          yield* user("go");
          return yield* step({ tools });
        });
        const { exit, history } = yield* turnOf(
          program,
          scriptedModel(
            [[call("ok", "write"), call("quota", "write"), call("never", "read")]],
            log,
          ),
        );
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(Quota);
        expect(log).toEqual([
          "generate:1",
          "write:ok:start",
          "write:ok:end",
          "write:ok:cleanup",
          "write:quota:start",
          "write:quota:cleanup",
        ]);
        expect(history).toEqual([]);

        const defectLog: Array<string> = [];
        const defect = yield* turnOf(
          Effect.flatMap(localTools(Tools, handlers(defectLog)), (tools) => step({ tools })),
          scriptedModel([[call("defect", "write")]], defectLog),
        );
        expect(Exit.isFailure(defect.exit) && Cause.hasDies(defect.exit.cause)).toBe(true);
      }),
  );

  it.effect(
    "waits for a held Tool and its cleanup before the next call, and drains on interruption",
    () =>
      Effect.gen(function* () {
        const log: Array<string> = [];
        const hold = yield* Deferred.make<void>();
        const program = Effect.gen(function* () {
          const tools = yield* localTools(Tools, handlers(log, hold));
          return yield* step({ tools });
        });
        const fiber = yield* Effect.forkChild(
          turnOf(program, scriptedModel([[call("a", "write"), call("b", "read")]], log)),
        );
        // Bounded, so a handler that never starts fails at the assertion, not the runner timeout.
        for (let i = 0; i < 1000 && !log.includes("write:a:start"); i++) yield* Effect.yieldNow;
        expect(log).toEqual(["generate:0", "write:a:start"]);
        yield* Fiber.interrupt(fiber);
        // The held handler was interrupted and its cleanup ran before the Turn returned.
        expect(log).toEqual(["generate:0", "write:a:start", "write:a:cleanup"]);
      }),
  );

  it.effect("settles a handler whose result Stream fails early before the Step returns", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const Early = Tool.make("early", {
        parameters: Schema.Struct({ key: Schema.String }),
        success: Schema.String,
      });
      const kit = Toolkit.make(Early);
      const program = Effect.gen(function* () {
        const tools = yield* localTools(kit, {
          early: (_, context) =>
            Effect.gen(function* () {
              // SAFETY: deliberately emits a value its success schema cannot encode.
              yield* context.preliminary(42 as never);
              return yield* Effect.never;
            }).pipe(Effect.ensuring(Effect.sync(() => void log.push("early:cleanup")))),
        });
        const failure = yield* Effect.flip(step({ tools }));
        // The Step has returned; its handler must already be settled, not still running.
        const settled = [...log];
        yield* Effect.yieldNow;
        return { failure, settled };
      });
      const { exit } = yield* turnOf(program, scriptedModel([[call("c1", "early")]], log));
      const { failure, settled } = yield* exit;
      expect(AiError.isAiError(failure) && failure.reason._tag).toBe("ToolResultEncodingError");
      expect(settled).toEqual(["generate:0", "early:cleanup"]);
    }),
  );

  it.effect(
    "enforces generation and dispatch limits before dispatch, and a program may catch them",
    () =>
      Effect.gen(function* () {
        const log: Array<string> = [];
        const looped = Effect.gen(function* () {
          const tools = yield* localTools(Tools, handlers(log));
          return yield* loop({ tools });
        });
        const exhausted = yield* turnOf(
          looped,
          scriptedModel([[call("a", "read")], [text("never")]], log),
          { generations: 1, dispatches: 256 },
        );
        expect(exhausted.exit).toEqual(
          Exit.fail(new ExecutionLimitError({ limit: "generations", bound: 1 })),
        );
        expect(log).toEqual(["generate:0", "read:a"]);

        // A live Session keeps the bounds it was made with, whatever the caller's object becomes.
        const bounds = { generations: 1, dispatches: 256 };
        const raised = yield* turnOf(
          Effect.gen(function* () {
            bounds.generations = 64;
            const tools = yield* localTools(Tools, handlers([]));
            return yield* loop({ tools });
          }),
          scriptedModel([[call("a", "read")], [text("never")]], []),
          bounds,
        );
        expect(raised.exit).toEqual(
          Exit.fail(new ExecutionLimitError({ limit: "generations", bound: 1 })),
        );

        const dispatchLog: Array<string> = [];
        const caught = Effect.gen(function* () {
          const tools = yield* localTools(Tools, handlers(dispatchLog));
          yield* user("go");
          const failure = yield* Effect.flip(step({ tools }));
          const turn = yield* Turn;
          return { failure, usage: yield* turn.usage };
        });
        const limited = yield* turnOf(
          caught,
          scriptedModel([[call("a", "read"), call("b", "read")]], dispatchLog),
          { generations: 64, dispatches: 1 },
        );
        const { failure, usage } = yield* limited.exit;
        expect(failure).toEqual(new ExecutionLimitError({ limit: "dispatches", bound: 1 }));
        expect(usage).toEqual({ generations: 1, dispatches: 1, physicalRequests: 1 });
        expect(dispatchLog).toEqual(["generate:1", "read:a"]);
        // The program caught the limit and returned normally: only its own valid staging commits.
        expect(limited.history.map((message) => message.role)).toEqual(["user"]);
      }),
  );

  it.effect("limits a Turn only by the bounds given, and counts its work without any", () =>
    Effect.gen(function* () {
      // 65 generations of four Tool Calls each, then an answer: past 64 generations and 256
      // dispatches.
      const script = () => [
        ...Array.from({ length: 65 }, (_, g) => [0, 1, 2, 3].map((i) => call(`${g}-${i}`, "read"))),
        [text("done")],
      ];
      const looped = Effect.gen(function* () {
        const tools = yield* localTools(Tools, handlers([]));
        yield* loop({ tools });
        return yield* turnUsage;
      });
      const unlimited = yield* turnOf(looped, scriptedModel(script(), []));
      expect(yield* unlimited.exit).toEqual({
        generations: 66,
        dispatches: 260,
        physicalRequests: 66,
      });

      // One bound given: it is enforced, and the other count has no limit.
      const generationsOnly = yield* turnOf(looped, scriptedModel(script(), []), {
        generations: 65,
      });
      expect(generationsOnly.exit).toEqual(
        Exit.fail(new ExecutionLimitError({ limit: "generations", bound: 65 })),
      );
      const plain = Effect.gen(function* () {
        for (let i = 0; i < 66; i++) yield* step();
        return yield* turnUsage;
      });
      const answers = () => Array.from({ length: 66 }, () => [text("ok")]);
      const dispatchesOnly = yield* turnOf(plain, scriptedModel(answers(), []), { dispatches: 0 });
      expect(yield* dispatchesOnly.exit).toEqual({
        generations: 66,
        dispatches: 0,
        physicalRequests: 66,
      });
      const refused = yield* turnOf(looped, scriptedModel(script(), []), { dispatches: 0 });
      expect(refused.exit).toEqual(
        Exit.fail(new ExecutionLimitError({ limit: "dispatches", bound: 0 })),
      );
    }),
  );

  it.effect("enforces a bound that is inherited or behind a getter", () =>
    Effect.gen(function* () {
      const looped = Effect.gen(function* () {
        const tools = yield* localTools(Tools, handlers([]));
        return yield* loop({ tools });
      });
      for (const limits of [
        Object.create({ dispatches: 0 }),
        new (class {
          get dispatches() {
            return 0;
          }
        })(),
      ]) {
        const refused = yield* turnOf(
          looped,
          scriptedModel([[call("a", "read")], [text("never")]], []),
          limits,
        );
        expect(refused.exit).toEqual(
          Exit.fail(new ExecutionLimitError({ limit: "dispatches", bound: 0 })),
        );
      }
    }),
  );

  it.effect("refuses a bound that is not a non-negative integer, Infinity included", () =>
    Effect.gen(function* () {
      for (const limits of [{ generations: Number.POSITIVE_INFINITY }, { dispatches: -1 }]) {
        const exit = yield* Effect.exit(
          Effect.scoped(Session.make({ transcript: "none", limits })),
        );
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toEqual(
          new RangeError("Execution limits must be non-negative integers"),
        );
      }
      // A misspelled bound would otherwise be dropped, leaving that count without a limit.
      const misspelled = { generations: 1, dispatch: 0 };
      const exit = yield* Effect.exit(
        Effect.scoped(Session.make({ transcript: "none", limits: misspelled })),
      );
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toEqual(
        new RangeError('Execution limits have no bound "dispatch"'),
      );
    }),
  );

  it.effect(
    "counts reported physical requests separately, including failed and zero-request generations",
    () =>
      Effect.gen(function* () {
        const failure = AiError.make({
          module: "test",
          method: "generate",
          reason: new AiError.InvalidRequestError({ description: "bad" }),
        });
        const retried = yield* turnOf(
          Effect.andThen(step(), turnUsage),
          scriptedModel([[text("ok")]], [], 3),
        );
        expect(yield* retried.exit).toEqual({ generations: 1, dispatches: 0, physicalRequests: 3 });

        const failed = yield* turnOf(
          Effect.flip(step()).pipe(Effect.zipWith(turnUsage, (error, used) => ({ error, used }))),
          scriptedModel([Effect.fail(failure)], [], 2),
        );
        const { error, used } = yield* failed.exit;
        expect(error).toBe(failure);
        expect(used).toEqual({ generations: 1, dispatches: 0, physicalRequests: 2 });

        const none = yield* turnOf(
          Effect.flip(step()).pipe(Effect.andThen(turnUsage)),
          scriptedModel([Effect.fail(failure)], [], 0),
        );
        expect(yield* none.exit).toEqual({ generations: 1, dispatches: 0, physicalRequests: 0 });
      }),
  );

  it.effect("registers handlers once and rejects ambiguous bindings", () =>
    Effect.gen(function* () {
      let builds = 0;
      const builder = Effect.sync(() => {
        builds += 1;
        return handlers([]);
      });
      const tools = yield* localTools(Tools, builder);
      const model = scriptedModel([[call("a", "read")], [call("b", "read")]], []);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* Session.make({ transcript: "none" });
          yield* session.run(step({ tools }).pipe(Effect.provide(model)));
          yield* session.run(step({ tools }).pipe(Effect.provide(model)));
        }),
      );
      expect(builds).toBe(1);
      const missing = yield* Effect.flip(
        // @ts-expect-error a handler map missing a Tool is also a type error
        localTools(Tools, { write: handlers([]).write, read: handlers([]).read }),
      );
      expect(missing).toBeInstanceOf(ToolRegistrationError);
    }),
  );

  it.effect("rejects a client-executed Tool, which it cannot dispatch, at registration", () =>
    Effect.gen(function* () {
      const Client = Tool.make("client", {
        parameters: Schema.Struct({ key: Schema.String }),
        success: Schema.String,
        execution: "client",
      });
      const handlers = { client: () => Effect.succeed("ran") };
      const rejected = yield* Effect.flip(localTools(Toolkit.make(Client), handlers));
      expect(rejected).toMatchObject({
        _tag: "ToolRegistrationError",
        detail: 'Tool "client" is not an ordinary Effect-Schema Tool',
      });
    }),
  );
});
