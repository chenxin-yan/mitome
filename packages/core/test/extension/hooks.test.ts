import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Stream } from "effect";
import { Prompt, Response, Tool, Toolkit } from "effect/unstable/ai";
import { Schema } from "effect";
import {
  TurnError,
  type AgentDefinition,
  createSession,
  type Extension,
  type ExtensionHooks,
} from "../../src/index.js";
import { makeTestProvider } from "../support/provider.js";

class HookFailure extends Schema.TaggedErrorClass<HookFailure>()("HookFailure", {
  message: Schema.String,
}) {}

const textModel = (capture: (prompt: Prompt.Prompt) => void) =>
  makeTestProvider(({ prompt }) => {
    capture(prompt);
    return Stream.succeed(Response.makePart("text-delta", { id: "done", delta: "done" }));
  });

const toolModel = () => {
  let calls = 0;
  let secondPrompt: Prompt.Prompt | undefined;
  return {
    provider: makeTestProvider((options) => {
      calls += 1;
      if (calls === 2) {
        secondPrompt = options.prompt;
        return Stream.succeed(Response.makePart("text-delta", { id: "done", delta: "done" }));
      }
      const call = Response.makePart("tool-call", {
        id: "call-1",
        name: "echo",
        params: "hello",
        providerExecuted: false,
      });
      return Stream.concat(
        Stream.succeed(call),
        Stream.unwrap(
          options.toolkit!.handle("echo", "hello").pipe(
            Effect.map((results) =>
              Stream.map(results, (result) =>
                Response.makePart("tool-result", {
                  id: call.id,
                  name: call.name,
                  providerExecuted: false,
                  ...result,
                }),
              ),
            ),
          ),
        ),
      );
    }),
    prompt: () => secondPrompt,
  };
};

describe("Extension Hooks", () => {
  it.effect(
    "runs notification Hooks in Agent Definition order and passes transformed prompts onward",
    () =>
      Effect.gen(function* () {
        const log: Array<string> = [];
        let modelPrompt: Prompt.Prompt | undefined;
        const extension = (name: string, transform?: boolean): Extension => ({
          name,
          hooks: {
            sessionStart: Effect.sync(() => void log.push(`${name}:session-start`)),
            sessionEnd: Effect.sync(() => void log.push(`${name}:session-end`)),
            turnStart: () => Effect.sync(() => void log.push(`${name}:turn-start`)),
            turnEnd: () => Effect.sync(() => void log.push(`${name}:turn-end`)),
            stepStart: () => Effect.sync(() => void log.push(`${name}:step-start`)),
            stepEnd: () => Effect.sync(() => void log.push(`${name}:step-end`)),
            preStep: (prompt) => {
              log.push(`${name}:pre-step:${JSON.stringify(prompt).includes("marker")}`);
              return Effect.succeed(transform ? Prompt.concat(prompt, "marker") : prompt);
            },
          },
        });
        const definition: AgentDefinition = {
          providers: [textModel((prompt) => (modelPrompt = prompt))],
          model: "test/default",
          extensions: [extension("first", true), extension("second")],
        };

        yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* createSession(definition);
            yield* Stream.runDrain(session.prompt("Hi"));
          }),
        );

        expect(log).toEqual([
          "first:session-start",
          "second:session-start",
          "first:turn-start",
          "second:turn-start",
          "first:step-start",
          "second:step-start",
          "first:pre-step:false",
          "second:pre-step:true",
          "first:step-end",
          "second:step-end",
          "first:turn-end",
          "second:turn-end",
          "first:session-end",
          "second:session-end",
        ]);
        expect(JSON.stringify(modelPrompt)).toContain("marker");
      }),
  );

  it.effect("brackets each model Step before beginning the next", () =>
    Effect.gen(function* () {
      const fixture = toolModel();
      const log: Array<string> = [];
      const responsePartTypes: Array<ReadonlyArray<string>> = [];
      let starts = 0;
      let ends = 0;
      const echo = Tool.make("echo", {
        parameters: Schema.String,
        success: Schema.String,
      });
      const definition: AgentDefinition = {
        providers: [fixture.provider],
        model: "test/default",
        extensions: [
          {
            name: "hooks",
            hooks: {
              stepStart: () => Effect.sync(() => void log.push(`stepStart(${++starts})`)),
              stepEnd: (_prompt, responseParts) =>
                Effect.sync(() => {
                  log.push(`stepEnd(${++ends})`);
                  responsePartTypes.push(responseParts.map((part) => part.type));
                }),
            },
          },
          {
            name: "tool",
            toolkit: Toolkit.make(echo),
            handlers: { echo: () => Effect.succeed("hello") },
          },
        ],
      };

      const session = yield* createSession(definition);
      yield* Stream.runDrain(session.prompt("Hi"));

      expect(log).toEqual(["stepStart(1)", "stepEnd(1)", "stepStart(2)", "stepEnd(2)"]);
      expect(responsePartTypes).toEqual([["tool-call", "tool-result"], ["text-delta"]]);
    }),
  );

  it.effect("keeps pre-Step context ephemeral across Turns", () =>
    Effect.gen(function* () {
      const prompts: Array<Prompt.Prompt> = [];
      let history: ReadonlyArray<Prompt.Message> = [];
      const definition: AgentDefinition = {
        providers: [textModel((prompt) => void prompts.push(prompt))],
        model: "test/default",
        extensions: [
          {
            name: "inject",
            hooks: {
              preStep: (prompt) => Effect.succeed(Prompt.concat(prompt, "marker")),
            },
          },
        ],
      };

      const session = yield* createSession(definition);
      yield* Stream.runDrain(session.prompt("first"));
      yield* Stream.runDrain(session.prompt("second"));
      history = session.history();

      expect(prompts).toHaveLength(2);
      expect(prompts.map((prompt) => JSON.stringify(prompt).match(/marker/g)?.length)).toEqual([
        1, 1,
      ]);
      expect(JSON.stringify(history)).not.toContain("marker");
    }),
  );

  it.effect("vetoes a Tool with a typed denial and skips its handler and post Hook", () =>
    Effect.gen(function* () {
      const fixture = toolModel();
      let handlerCalls = 0;
      let postCalls = 0;
      const echo = Tool.make("echo", {
        parameters: Schema.String,
        success: Schema.String,
        failureMode: "return",
      });
      const definition: AgentDefinition = {
        providers: [fixture.provider],
        model: "test/default",
        extensions: [
          {
            name: "veto",
            hooks: {
              preTool: () => Effect.succeed({ reason: "not now" }),
              postTool: () => Effect.sync(() => ++postCalls),
            },
          },
          {
            name: "tool",
            toolkit: Toolkit.make(echo),
            handlers: { echo: () => Effect.sync(() => ++handlerCalls) },
          },
        ],
      };

      const session = yield* createSession(definition);
      const events = yield* Stream.runCollect(session.prompt("Hi"));

      const denial = events.find((event) => event.type === "tool-result");
      expect(denial).toMatchObject({
        type: "tool-result",
        isFailure: true,
        result: { type: "execution-denied", reason: "not now" },
      });
      expect(handlerCalls).toBe(0);
      expect(postCalls).toBe(0);
      expect(JSON.stringify(fixture.prompt())).toContain("not now");
      expect(events.at(-1)).toEqual({ type: "response-complete" });
    }),
  );

  it.effect("revalidates post-Tool transforms before adding them to history", () =>
    Effect.gen(function* () {
      const fixture = toolModel();
      const echo = Tool.make("echo", {
        parameters: Schema.String,
        success: Schema.String,
      });
      const valid: AgentDefinition = {
        providers: [fixture.provider],
        model: "test/default",
        extensions: [
          {
            name: "transform",
            hooks: {
              postTool: ({ result }) => Effect.succeed(`${String(result)}!`),
            },
          },
          {
            name: "tool",
            toolkit: Toolkit.make(echo),
            handlers: { echo: () => Effect.succeed("hello") },
          },
        ],
      };
      const session = yield* createSession(valid);
      const events = yield* Stream.runCollect(session.prompt("Hi"));
      expect(events).toContainEqual({
        type: "tool-result",
        id: "call-1",
        name: "echo",
        result: "hello!",
        isFailure: false,
      });
      expect(JSON.stringify(fixture.prompt())).toContain("hello!");

      const invalidFixture = toolModel();
      const invalid: AgentDefinition = {
        ...valid,
        providers: [invalidFixture.provider],
        model: "test/default",
        extensions: [
          { name: "transform", hooks: { postTool: () => Effect.succeed(1) } },
          valid.extensions[1]!,
        ],
      };
      let failure: unknown;
      let history: ReadonlyArray<unknown> = [];
      const invalidSession = yield* createSession(invalid);
      const exit = yield* Effect.exit(Stream.runDrain(invalidSession.prompt("Hi")));
      failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
      history = invalidSession.history();
      expect(failure).toBeInstanceOf(TurnError);
      expect(history).toHaveLength(0);
    }),
  );

  it.effect("only ends lifecycle phases that started", () =>
    Effect.gen(function* () {
      let sessionEnds = 0;
      const startupExit = yield* Effect.exit(
        createSession({
          providers: [textModel(() => undefined)],
          model: "test/default",
          extensions: [
            {
              name: "bad",
              hooks: {
                sessionStart: Effect.fail(new HookFailure({ message: "startup" })),
                sessionEnd: Effect.sync(() => ++sessionEnds),
              },
            },
          ],
        }),
      );
      expect(Exit.isFailure(startupExit)).toBe(true);
      expect(sessionEnds).toBe(0);

      let laterTurnStarts = 0;
      let turnEnds = 0;
      const turnSession = yield* createSession({
        providers: [textModel(() => undefined)],
        model: "test/default",
        extensions: [
          {
            name: "bad",
            hooks: {
              turnStart: () => Effect.fail(new HookFailure({ message: "turn" })),
              turnEnd: () => Effect.sync(() => ++turnEnds),
            },
          },
          {
            name: "later",
            hooks: {
              turnStart: () => Effect.sync(() => ++laterTurnStarts),
              turnEnd: () => Effect.sync(() => ++turnEnds),
            },
          },
        ],
      });
      yield* Effect.exit(Stream.runDrain(turnSession.prompt("Hi")));
      expect(laterTurnStarts).toBe(0);
      expect(turnEnds).toBe(0);

      const stepLog: Array<string> = [];
      const stepSession = yield* createSession({
        providers: [textModel(() => undefined)],
        model: "test/default",
        extensions: [
          {
            name: "bad",
            hooks: {
              stepStart: () => Effect.sync(() => void stepLog.push("start")),
              preStep: () => Effect.fail(new HookFailure({ message: "pre-step" })),
              stepEnd: () => Effect.sync(() => void stepLog.push("end")),
            },
          },
        ],
      });
      yield* Effect.exit(Stream.runDrain(stepSession.prompt("Hi")));
      expect(stepLog).toEqual(["start", "end"]);
    }),
  );

  it.effect("ends successful Hook prefixes when a later start fails", () =>
    Effect.gen(function* () {
      const sessionLog: Array<string> = [];
      yield* Effect.exit(
        createSession({
          providers: [textModel(() => undefined)],
          model: "test/default",
          extensions: [
            {
              name: "started",
              hooks: {
                sessionStart: Effect.sync(() => void sessionLog.push("start:first")),
                sessionEnd: Effect.sync(() => void sessionLog.push("end:first")),
              },
            },
            {
              name: "failed",
              hooks: {
                sessionStart: Effect.sync(() => void sessionLog.push("start:second")).pipe(
                  Effect.andThen(Effect.fail(new HookFailure({ message: "session" }))),
                ),
                sessionEnd: Effect.sync(() => void sessionLog.push("end:second")),
              },
            },
          ],
        }),
      );
      expect(sessionLog).toEqual(["start:first", "start:second", "end:first"]);

      const turnLog: Array<string> = [];
      const turnSession = yield* createSession({
        providers: [textModel(() => undefined)],
        model: "test/default",
        extensions: [
          {
            name: "started",
            hooks: {
              turnStart: () => Effect.sync(() => void turnLog.push("start:first")),
              turnEnd: () => Effect.sync(() => void turnLog.push("end:first")),
            },
          },
          {
            name: "failed",
            hooks: {
              turnStart: () =>
                Effect.sync(() => void turnLog.push("start:second")).pipe(
                  Effect.andThen(Effect.fail(new HookFailure({ message: "turn" }))),
                ),
              turnEnd: () => Effect.sync(() => void turnLog.push("end:second")),
            },
          },
        ],
      });
      yield* Effect.exit(Stream.runDrain(turnSession.prompt("Hi")));
      expect(turnLog).toEqual(["start:first", "start:second", "end:first"]);

      const stepLog: Array<string> = [];
      const stepSession = yield* createSession({
        providers: [textModel(() => undefined)],
        model: "test/default",
        extensions: [
          {
            name: "started",
            hooks: {
              stepStart: () => Effect.sync(() => void stepLog.push("start:first")),
              stepEnd: () => Effect.sync(() => void stepLog.push("end:first")),
            },
          },
          {
            name: "failed",
            hooks: {
              stepStart: () =>
                Effect.sync(() => void stepLog.push("start:second")).pipe(
                  Effect.andThen(Effect.fail(new HookFailure({ message: "step" }))),
                ),
              stepEnd: () => Effect.sync(() => void stepLog.push("end:second")),
            },
          },
        ],
      });
      yield* Effect.exit(Stream.runDrain(stepSession.prompt("Hi")));
      expect(stepLog).toEqual(["start:first", "start:second", "end:first"]);
    }),
  );

  it.effect("continues cleanup Hooks after an earlier cleanup fails", () =>
    Effect.gen(function* () {
      const sessionLog: Array<string> = [];
      yield* Effect.scoped(
        createSession({
          providers: [textModel(() => undefined)],
          model: "test/default",
          extensions: [
            {
              name: "first",
              hooks: {
                sessionEnd: Effect.sync(() => void sessionLog.push("first")).pipe(
                  Effect.andThen(Effect.fail(new HookFailure({ message: "sessionEnd" }))),
                ),
              },
            },
            {
              name: "second",
              hooks: {
                sessionEnd: Effect.sync(() => void sessionLog.push("second")),
              },
            },
          ],
        }),
      );
      expect(sessionLog).toEqual(["first", "second"]);

      const turnLog: Array<string> = [];
      const failingModel = makeTestProvider(() =>
        Stream.fail(new HookFailure({ message: "model" })),
      );
      const session = yield* createSession({
        providers: [failingModel],
        model: "test/default",
        extensions: [
          {
            name: "first",
            hooks: {
              stepEnd: () =>
                Effect.sync(() => void turnLog.push("step:first")).pipe(
                  Effect.andThen(Effect.fail(new HookFailure({ message: "stepEnd" }))),
                ),
              turnEnd: () =>
                Effect.sync(() => void turnLog.push("turn:first")).pipe(
                  Effect.andThen(Effect.fail(new HookFailure({ message: "turnEnd" }))),
                ),
            },
          },
          {
            name: "second",
            hooks: {
              stepEnd: () => Effect.sync(() => void turnLog.push("step:second")),
              turnEnd: () => Effect.sync(() => void turnLog.push("turn:second")),
            },
          },
        ],
      });
      yield* Effect.exit(Stream.runDrain(session.prompt("Hi")));
      expect(turnLog).toEqual(["step:first", "step:second", "turn:first", "turn:second"]);
    }),
  );

  it.effect("emits response-complete only after turnEnd succeeds", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const session = yield* createSession({
        providers: [textModel(() => undefined)],
        model: "test/default",
        extensions: [
          {
            name: "hooks",
            hooks: {
              turnEnd: () => Effect.sync(() => void log.push("turn-end")),
            },
          },
        ],
      });
      yield* Stream.runForEach(session.prompt("Hi"), (event) =>
        Effect.sync(() => void log.push(event.type)),
      );
      expect(log).toEqual(["model-output", "turn-end", "response-complete"]);
    }),
  );

  it.effect("does not commit history or completion when turnEnd fails", () =>
    Effect.gen(function* () {
      const events: Array<string> = [];
      let history: ReadonlyArray<Prompt.Message> = [];
      const session = yield* createSession({
        providers: [textModel(() => undefined)],
        model: "test/default",
        extensions: [
          {
            name: "bad",
            hooks: {
              turnEnd: () => Effect.fail(new HookFailure({ message: "turnEnd" })),
            },
          },
        ],
      });
      const exit = yield* Effect.exit(
        Stream.runForEach(session.prompt("Hi"), (event) =>
          Effect.sync(() => void events.push(event.type)),
        ),
      );
      history = session.history();
      expect(Exit.isFailure(exit)).toBe(true);
      expect(events).toEqual(["model-output"]);
      expect(history).toHaveLength(0);
    }),
  );

  const failingTurnHooks: ReadonlyArray<readonly [string, ExtensionHooks]> = [
    [
      "stepStart",
      {
        stepStart: () => Effect.fail(new HookFailure({ message: "stepStart" })),
      },
    ],
    ["preStep", { preStep: () => Effect.fail(new HookFailure({ message: "preStep" })) }],
    ["preTool", { preTool: () => Effect.fail(new HookFailure({ message: "preTool" })) }],
    ["postTool", { postTool: () => Effect.fail(new HookFailure({ message: "postTool" })) }],
    ["stepEnd", { stepEnd: () => Effect.fail(new HookFailure({ message: "stepEnd" })) }],
    ["turnEnd", { turnEnd: () => Effect.fail(new HookFailure({ message: "turnEnd" })) }],
  ];

  for (const [hookName, hooks] of failingTurnHooks) {
    it.effect(`fails the Turn when ${hookName} fails`, () =>
      Effect.gen(function* () {
        const fixture = toolModel();
        const echo = Tool.make("echo", {
          parameters: Schema.String,
          success: Schema.String,
        });
        const session = yield* createSession({
          providers: [fixture.provider],
          model: "test/default",
          extensions: [
            { name: "bad", hooks },
            {
              name: "tool",
              toolkit: Toolkit.make(echo),
              handlers: { echo: () => Effect.succeed("hello") },
            },
          ],
        });
        const exit = yield* Effect.exit(Stream.runDrain(session.prompt("Hi")));
        const failure = Cause.squash(Exit.isFailure(exit) ? exit.cause : Cause.empty);
        expect(failure).toBeInstanceOf(TurnError);
        if (hookName === "preTool" || hookName === "postTool") {
          expect(failure).toMatchObject({
            message: `${hookName === "preTool" ? "Pre-Tool" : "Post-Tool"} Hook failed: ${hookName}`,
            cause: {
              _tag: "AiError",
              module: "@mitome/core",
              method: hookName,
            },
          });
        } else {
          expect(failure).toMatchObject({ cause: { message: hookName } });
        }
      }),
    );
  }

  it.effect("fails startup and Turns for unrecovered Hooks while allowing Extension recovery", () =>
    Effect.gen(function* () {
      const startup = new HookFailure({ message: "startup" });
      const startupDefinition: AgentDefinition = {
        providers: [textModel(() => undefined)],
        model: "test/default",
        extensions: [{ name: "bad", hooks: { sessionStart: Effect.fail(startup) } }],
      };
      const startupExit = yield* Effect.exit(createSession(startupDefinition));
      expect(
        Cause.squash(Exit.isFailure(startupExit) ? startupExit.cause : Cause.empty),
      ).toMatchObject({
        _tag: "TurnError",
        cause: startup,
      });

      const turn = new HookFailure({ message: "turn" });
      const turnDefinition: AgentDefinition = {
        providers: [textModel(() => undefined)],
        model: "test/default",
        extensions: [{ name: "bad", hooks: { turnStart: () => Effect.fail(turn) } }],
      };
      const turnSession = yield* createSession(turnDefinition);
      const turnExit = yield* Effect.exit(Stream.runDrain(turnSession.prompt("Hi")));
      expect(Cause.squash(Exit.isFailure(turnExit) ? turnExit.cause : Cause.empty)).toMatchObject({
        _tag: "TurnError",
        cause: turn,
      });

      const recovered: AgentDefinition = {
        providers: [textModel(() => undefined)],
        model: "test/default",
        extensions: [
          {
            name: "recover",
            hooks: { turnStart: () => Effect.fail(turn).pipe(Effect.ignore) },
          },
        ],
      };
      const recoveredSession = yield* createSession(recovered);
      yield* Stream.runDrain(recoveredSession.prompt("Hi"));
    }),
  );
});
