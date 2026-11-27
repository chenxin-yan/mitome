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
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai";
import {
  type ApprovalDecision,
  Approver,
  reportModelRequest,
  SessionReleasedError,
  Turn,
  withModelRequestAccounting,
} from "../../src/index.js";
import { localTools, loop, Session, step } from "../../src/kernel.js";
import { call, finish, scriptedModel, text } from "../support/step.js";
import { recordingTranscript } from "../support/transcript.js";

// Review corrections: a Turn handle that escaped its Turn authorizes no controlled work, and the
// conversation projection of a native `Schema.Void` result is JSON null.

const Write = Tool.make("write", {
  parameters: Schema.Struct({ key: Schema.String }),
  success: Schema.String,
});
const Kit = Toolkit.make(Write);

const currentTurn = Turn;

const defect = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && Cause.hasDies(exit.cause) && !Cause.hasFails(exit.cause);

describe("controlled Steps after their Turn", () => {
  it.effect(
    "a returned Turn sends no request and dispatches nothing, even for incomplete data",
    () =>
      Effect.gen(function* () {
        for (const reply of [[call("c1", "write")], [call("c1", "write"), finish("length")]]) {
          const log: Array<string> = [];
          const ran: Array<string> = [];
          const outcome = yield* Effect.scoped(
            Effect.gen(function* () {
              const session = yield* Session.make({ transcript: "none" });
              const tools = yield* localTools(Kit, {
                write: ({ key }) => Effect.sync(() => (ran.push(key), key)),
              });
              const stale = yield* session.run(currentTurn);
              const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                effect.pipe(
                  Effect.provideService(Turn, stale),
                  Effect.provide(scriptedModel([reply], log)),
                );
              const single = yield* Effect.exit(provide(step({ tools })));
              const looped = yield* Effect.exit(provide(loop({ tools })));
              // Usage stays readable while the Session lives and shows nothing was reserved.
              const usage = yield* stale.usage;
              return { single, looped, usage, history: yield* session.history };
            }),
          );
          expect(defect(outcome.single)).toBe(true);
          expect(defect(outcome.looped)).toBe(true);
          expect(log).toEqual([]);
          expect(ran).toEqual([]);
          expect(outcome.usage).toEqual({ generations: 0, dispatches: 0, physicalRequests: 0 });
          expect(outcome.history).toEqual([]);
        }
      }),
  );

  it.effect("rejects usage once the Session is released and sends nothing", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const stale = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* Session.make({ transcript: "none" });
          return yield* session.run(currentTurn);
        }),
      );
      expect(yield* Effect.flip(stale.usage)).toBeInstanceOf(SessionReleasedError);
      const exit = yield* Effect.exit(
        step().pipe(Effect.provideService(Turn, stale), Effect.provide(scriptedModel([], log))),
      );
      expect(defect(exit)).toBe(true);
      expect(log).toEqual([]);
    }),
  );

  it.effect("still counts a request already sent when its Turn ends before the response", () =>
    Effect.gen(function* () {
      const requested = yield* Deferred.make<void>();
      const respond = yield* Deferred.make<void>();
      const model = withModelRequestAccounting(
        "held",
        Layer.effect(
          LanguageModel.LanguageModel,
          LanguageModel.make({
            generateText: () =>
              Effect.gen(function* () {
                yield* reportModelRequest;
                yield* Deferred.succeed(requested, undefined);
                yield* Deferred.await(respond);
                return [text("late")];
              }),
            streamText: () => Stream.die(new Error("not streamed")),
          }),
        ),
      );
      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* Session.make({ transcript: "none" });
          const { fiber, turn } = yield* session.run(
            Effect.gen(function* () {
              const fiber = yield* step().pipe(Effect.provide(model), Effect.forkDetach);
              yield* Deferred.await(requested);
              return { fiber, turn: yield* Turn };
            }),
          );
          yield* Deferred.succeed(respond, undefined);
          const exit = yield* Fiber.await(fiber);
          return { exit, usage: yield* turn.usage, history: yield* session.history };
        }),
      );
      // The late response cannot stage into the ended Turn, but its request stays counted.
      expect(defect(outcome.exit)).toBe(true);
      expect(outcome.usage).toEqual({ generations: 1, dispatches: 0, physicalRequests: 1 });
      expect(outcome.history).toEqual([]);
    }),
  );

  it.effect("a detached Step waiting on its Approver past its Turn never enters the handler", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const ran: Array<string> = [];
      const asked = yield* Deferred.make<void>();
      const grant = yield* Deferred.make<ApprovalDecision>();
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* Session.make({ transcript: "none" });
          const tools = yield* localTools(Kit, {
            write: ({ key }) => Effect.sync(() => (ran.push(key), key)),
          });
          // The Step starts inside the Turn and is waiting on its Approver when the Turn returns.
          const detached = yield* session.run(
            Effect.gen(function* () {
              const fiber = yield* step({ tools, policy: () => Effect.succeed("ask") }).pipe(
                Effect.provide(scriptedModel([[call("c1", "write")]], log)),
                Effect.provideService(Approver, {
                  decide: () =>
                    Effect.andThen(Deferred.succeed(asked, undefined), Deferred.await(grant)),
                }),
                Effect.forkDetach,
              );
              yield* Deferred.await(asked);
              return fiber;
            }),
          );
          // The Turn has ended; the answer now arrives for the stale Step.
          yield* Deferred.succeed(grant, "allow");
          const exit = yield* Fiber.await(detached);
          const turn = yield* session.turns;
          return { exit, phase: turn[0]?.phase, history: yield* session.history };
        }),
      );
      expect(log).toEqual(["generate:0"]);
      expect(ran).toEqual([]);
      expect(Exit.isFailure(result.exit)).toBe(true);
      expect(result.phase).toBe("succeeded");
      expect(result.history).toEqual([]);
    }),
  );
});

class Encoder extends Context.Service<Encoder, { readonly tag: string }>()("test/Encoder") {}

describe("Tool result projection and codecs", () => {
  const Nothing = Tool.make("nothing", { parameters: Schema.Struct({ key: Schema.String }) });
  const Amount = Tool.make("amount", {
    parameters: Schema.Struct({ key: Schema.String }),
    // Native value is a number; its encoded (wire) form is a string.
    success: Schema.String.pipe(
      Schema.decodeTo(Schema.Finite, {
        decode: SchemaGetter.transform((value: string) => Number(value)),
        encode: SchemaGetter.transform((value: number) => `n=${value}`),
      }),
    ),
  });
  // Serviceful success and failure encodings.
  const tagged = (label: string) =>
    Schema.String.pipe(
      Schema.decodeTo(Schema.String, {
        decode: SchemaGetter.transform((value: string) => value),
        encode: SchemaGetter.transformEffect((value: string) =>
          Effect.map(Encoder, (encoder) => `${encoder.tag}:${label}:${value}`),
        ),
      }),
    );
  const Coded = Tool.make("coded", {
    parameters: Schema.Struct({ key: Schema.String }),
    success: tagged("ok"),
    failure: Schema.Struct({ code: Schema.Finite }).pipe(
      Schema.decodeTo(Schema.Struct({ code: Schema.Finite }), {
        decode: SchemaGetter.transform((value: { readonly code: number }) => value),
        encode: SchemaGetter.transformEffect((value: { readonly code: number }) =>
          Effect.map(Encoder, (encoder) => ({ code: value.code + encoder.tag.length })),
        ),
      }),
    ),
    failureMode: "return",
  });
  const Kit2 = Toolkit.make(Nothing, Amount, Coded);

  it.effect("stages a Void result as null and keeps native and encoded values elsewhere", () =>
    Effect.gen(function* () {
      const saved: Array<ReadonlyArray<Prompt.Message>> = [];
      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* Session.make({
            transcript: recordingTranscript((entry) =>
              Effect.sync(() => void saved.push(entry.messages)),
            ).transcript,
          });
          const tools = yield* localTools(Kit2, {
            nothing: () => Effect.void,
            amount: () => Effect.succeed(7),
            coded: ({ key }) =>
              key === "fail" ? Effect.fail({ code: 40 }) : Effect.succeed(`v-${key}`),
          });
          return yield* session.run(
            step({ tools }).pipe(
              Effect.provide(
                scriptedModel(
                  [
                    [
                      call("v", "nothing"),
                      call("a", "amount"),
                      call("c", "coded"),
                      call("fail", "coded"),
                    ],
                  ],
                  [],
                ),
              ),
              Effect.provideService(Encoder, { tag: "enc" }),
            ),
          );
        }),
      );
      if (!Predicate.isTagged(outcome, "Complete")) {
        throw new Error("expected a complete Step");
      }
      // Returned results: native values, and the encodings of each schema's JSON codec.
      expect(outcome.results.map((part) => [part.id, part.result, part.encodedResult])).toEqual([
        ["v", undefined, null],
        ["a", 7, "n=7"],
        ["c", "v-c", "enc:ok:v-c"],
        ["fail", { code: 40 }, { code: 43 }],
      ]);
      // The stored Entry carries the same encodings.
      const history = saved[0] ?? [];
      const toolMessage = history.find(
        (message): message is Prompt.ToolMessage => message.role === "tool",
      );
      const results = (toolMessage?.content ?? []).map((part) =>
        part.type === "tool-result" ? [part.id, part.result, part.isFailure] : [],
      );
      expect(results).toEqual([
        ["v", null, false],
        ["a", "n=7", false],
        ["c", "enc:ok:v-c", false],
        ["fail", { code: 43 }, true],
      ]);
      // The projection encodes to valid JSON.
      expect(
        Schema.is(Schema.Json)(yield* Schema.encodeEffect(Schema.Array(Prompt.Message))(history)),
      ).toBe(true);
    }),
  );

  it.effect("stages a top-level undefined that a schema's JSON codec keeps as null", () =>
    Effect.gen(function* () {
      const Loose = Tool.make("loose", {
        parameters: Schema.Struct({ key: Schema.String }),
        success: Schema.Any,
      });
      const staged = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* Session.make({ transcript: "none" });
          const tools = yield* localTools(Toolkit.make(Loose), { loose: () => Effect.void });
          const outcome = yield* session.run(
            step({ tools }).pipe(Effect.provide(scriptedModel([[call("l", "loose")]], []))),
          );
          return { outcome, history: yield* session.history };
        }),
      );
      if (!Predicate.isTagged(staged.outcome, "Complete")) {
        throw new Error("expected a complete Step");
      }
      expect(staged.outcome.results[0]?.encodedResult).toBeUndefined();
      const tool = staged.history.find(
        (message): message is Prompt.ToolMessage => message.role === "tool",
      );
      const part = tool?.content[0];
      expect(part?.type === "tool-result" ? part.result : "missing").toBeNull();
    }),
  );

  it.effect(
    "a top-level undefined is the only value projected; nested undefined is not rewritten",
    () =>
      Effect.gen(function* () {
        const Profile = Tool.make("profile", {
          parameters: Schema.Struct({ key: Schema.String }),
          success: Schema.Struct({ inner: Schema.optional(Schema.String) }),
        });
        const staged = yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* Session.make({ transcript: "none" });
            const tools = yield* localTools(Toolkit.make(Profile), {
              profile: () => Effect.succeed({}),
            });
            yield* session.run(
              step({ tools }).pipe(
                Effect.provide(scriptedModel([[call("s", "profile")], [text("x")]], [])),
              ),
            );
            return yield* session.history;
          }),
        );
        const tool = staged.find(
          (message): message is Prompt.ToolMessage => message.role === "tool",
        );
        const part = tool?.content[0];
        expect(part?.type === "tool-result" ? part.result : "missing").toEqual({});
      }),
  );
});
