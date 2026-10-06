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
  Ref,
  Schema,
  SchemaGetter,
  Scope,
  Stream,
} from "effect";
import { AiError, LanguageModel, Prompt, Response, Tool, Toolkit } from "effect/ai";
import {
  ExecutionLimitError,
  IncompleteStepError,
  localTools,
  loop,
  makeProvider,
  makeSession,
  ModelRequestAccounting,
  providerModel,
  step,
  StepProtocolError,
  ToolRegistrationError,
  Turn,
  withModelRequestAccounting,
  type CompleteStep,
  type ExecutionLimits,
  type StepOptions,
  type StepResult,
} from "../../src/index.js";
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

const limits: ExecutionLimits = { generations: 64, dispatches: 256 };

class Approvals extends Context.Service<Approvals, { readonly allowed: ReadonlySet<string> }>()(
  "test/Approvals",
) {}

class Quota extends Schema.TaggedError<Quota>()("Quota", {}) {}

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
  sessionLimits = limits,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* makeSession({ persistence: "none", limits: sessionLimits });
      const exit = yield* Effect.exit(session.run(program.pipe(Effect.provide(model))));
      return { exit, history: yield* session.history };
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
  it.effect("runs two local Tool Calls serially through the default loop and commits once", () =>
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
      const { exit, history } = yield* turnOf(program, model);
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
      const accounted = makeProvider("accounted", [] as const, undefined, () =>
        scriptedModel([[text("ok")]], log),
      );
      const { exit } = yield* turnOf(
        Effect.andThen(step(), turnUsage),
        providerModel(accounted, "m"),
      );
      expect(yield* exit).toEqual({ generations: 1, dispatches: 0, physicalRequests: 1 });

      // A binding without its own declaration, or declaring another Model, is refused before
      // any request.
      const bare = makeProvider("bare", [] as const, undefined, () =>
        scriptedLanguageModel([[text("never")]], log),
      );
      const foreign = makeProvider("foreign", [] as const, undefined, () =>
        Layer.merge(scriptedLanguageModel([[text("never")]], log), foreignAccounting),
      );
      for (const provider of [bare, foreign]) {
        const refused = yield* turnOf(step(), providerModel(provider, "m"));
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
        Effect.flip(step()).pipe(
          Effect.flatMap((error) => Effect.map(turnUsage, (used) => ({ error, used }))),
        ),
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

  it.effect("fails closed on denial, policy failure and missing consent", () =>
    Effect.gen(function* () {
      const run = (
        options: Omit<Parameters<typeof step<Toolkit.Tools<typeof Tools>>>[0] & {}, "tools">,
      ) =>
        Effect.gen(function* () {
          const log: Array<string> = [];
          const program = Effect.gen(function* () {
            const tools = yield* localTools(Tools, handlers(log));
            return yield* step({ tools, ...options });
          });
          const result = yield* turnOf(
            program,
            scriptedModel([[call("c1", "write"), call("c2", "soft")]], log),
          );
          return { ...result, log };
        });
      for (const options of [
        { policy: () => Effect.succeed("deny" as const) },
        { policy: () => Effect.fail("policy broke") },
        { policy: () => Effect.die("policy defect") },
        { policy: () => Effect.succeed("ask" as const) },
        { policy: () => Effect.succeed("ask" as const), consent: () => Effect.succeed(false) },
        { policy: () => Effect.succeed("ask" as const), consent: () => Effect.fail("offline") },
      ]) {
        const { exit, log } = yield* run(options);
        // Error-mode `write` fails the Step with the library's native AiError; its handler never ran.
        expect(Exit.isFailure(exit) && AiError.isAiError(Cause.squash(exit.cause))).toBe(true);
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

  it.effect(
    "binds consent to the exact decoded call and never dispatches once the Turn is interrupted",
    () =>
      Effect.gen(function* () {
        const log: Array<string> = [];
        const seen: Array<unknown> = [];
        const Seen = Tool.make("seen", {
          parameters: Schema.Struct({ key: Schema.String }),
          success: Schema.String,
        });
        const kit = Toolkit.make(Seen);
        const program = Effect.gen(function* () {
          const tools = yield* localTools(kit, {
            seen: (params) => Effect.sync(() => (seen.push(params), log.push("seen"), "ok")),
          });
          return yield* step({
            tools,
            policy: () => Effect.succeed("ask"),
            consent: (request) => Effect.sync(() => (seen.push(request.params), true)),
          });
        });
        const { exit } = yield* turnOf(program, scriptedModel([[call("c1", "seen")]], log));
        yield* exit;
        expect(seen.length).toBe(2);
        expect(seen[0]).toBe(seen[1]);

        // Interrupting the Turn while consent is pending never enters the handler.
        const held: Array<string> = [];
        const pending = yield* Deferred.make<boolean>();
        const waiting = yield* Deferred.make<void>();
        const interrupted = Effect.gen(function* () {
          const tools = yield* localTools(kit, {
            seen: () => Effect.sync(() => (held.push("seen"), "ok")),
          });
          return yield* step({
            tools,
            policy: () => Effect.succeed("ask"),
            consent: () =>
              Effect.andThen(Deferred.succeed(waiting, undefined), Deferred.await(pending)),
          });
        });
        const fiber = yield* Effect.forkChild(
          turnOf(interrupted, scriptedModel([[call("c1", "seen")]], held)),
        );
        yield* Deferred.await(waiting);
        yield* Fiber.interrupt(fiber);
        yield* Deferred.succeed(pending, true);
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
        return yield* step({
          tools,
          consent: (request) => Effect.sync(() => (asked.push(request.toolCallId), true)),
        });
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

  it.effect("rechecks current authority after consent without repeating the decision", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const counts = { policy: 0, consent: 0, authority: 0 };
      const revoked = yield* Ref.make(false);
      const program = Effect.gen(function* () {
        const tools = yield* localTools(Tools, handlers(log));
        return yield* step({
          tools,
          policy: () => Effect.sync(() => (counts.policy++, "ask" as const)),
          // Authority is revoked while consent is pending.
          consent: () =>
            Effect.andThen(
              Ref.set(revoked, true),
              Effect.sync(() => (counts.consent++, true)),
            ),
          authority: () => Effect.map(Ref.get(revoked), (gone) => (counts.authority++, !gone)),
        });
      });
      const { exit, history } = yield* turnOf(program, scriptedModel([[call("c1", "write")]], log));
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
      expect(AiError.isAiError(error) && error.reason._tag).toBe("UnknownError");
      expect(counts).toEqual({ policy: 1, consent: 1, authority: 1 });
      expect(log).toEqual(["generate:0"]);
      expect(history).toEqual([]);

      // An authority failure or defect also denies; interruption is not swallowed.
      for (const authority of [() => Effect.fail("offline"), () => Effect.die("broken")]) {
        const denied: Array<string> = [];
        const result = yield* turnOf(
          Effect.flatMap(localTools(Tools, handlers(denied)), (tools) =>
            step({ tools, authority }),
          ),
          scriptedModel([[call("c1", "soft")]], denied),
        );
        const completed = yield* result.exit;
        assertComplete(completed);
        expect(completed.results.map((part) => part.isFailure)).toEqual([true]);
        expect(denied).toEqual(["generate:0"]);
      }
      const interrupted = yield* turnOf(
        Effect.flatMap(localTools(Tools, handlers([])), (tools) =>
          step({ tools, authority: () => Effect.interrupt }),
        ),
        scriptedModel([[call("c1", "soft")]], []),
      );
      expect(
        Exit.isFailure(interrupted.exit) && Cause.hasInterruptsOnly(interrupted.exit.cause),
      ).toBe(true);
    }),
  );

  it.effect("denies when policy, consent or authority throws synchronously", () =>
    Effect.gen(function* () {
      const thrown = (): never => {
        throw new Error("offline");
      };
      const cases: ReadonlyArray<StepOptions<Toolkit.Tools<typeof Tools>>> = [
        { policy: thrown },
        { policy: () => Effect.succeed("ask"), consent: thrown },
        { authority: thrown },
      ];
      for (const options of cases) {
        const denied: Array<string> = [];
        const result = yield* turnOf(
          Effect.flatMap(localTools(Tools, handlers(denied)), (tools) =>
            step({ ...options, tools }),
          ),
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

  it.effect("runs serviceful policy, consent and authority with the Step caller's services", () =>
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
          consent: allowed,
          authority: allowed,
        });
      }).pipe(Effect.provideService(Approvals, { allowed: new Set(["read"]) }));
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

  it.effect("prepends Instructions to the Model Prompt without staging them", () =>
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
        yield* Effect.yieldNow;
        while (!log.includes("write:a:start")) yield* Effect.yieldNow;
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
          Effect.flip(step()).pipe(
            Effect.flatMap((error) => Effect.map(turnUsage, (used) => ({ error, used }))),
          ),
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

  it.effect("keeps executing and commits when an observer stops early", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const hold = yield* Deferred.make<void>();
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeSession({ persistence: "none", limits });
          const observerScope = yield* Scope.make();
          yield* session.observe(1).pipe(Scope.provide(observerScope));
          const program = Effect.gen(function* () {
            const tools = yield* localTools(Tools, handlers(log, hold));
            yield* user("go");
            return yield* loop({ tools });
          }).pipe(Effect.provide(scriptedModel([[call("a", "write")], [text("done")]], log)));
          const fiber = yield* Effect.forkChild(session.run(program));
          while (!log.includes("write:a:start")) yield* Effect.yieldNow;
          yield* Scope.close(observerScope, Exit.void);
          yield* Deferred.succeed(hold, undefined);
          const final = yield* Fiber.join(fiber);
          return { final, history: yield* session.history };
        }),
      );
      expect(result.final.response.text).toBe("done");
      expect(result.history.length).toBe(4);
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
          const session = yield* makeSession({ persistence: "none", limits });
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
});
