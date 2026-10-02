// The real OpenTUI test renderer driving `runTerminal` over a real acquired application: a native
// Session, scripted Model, registered Tools and the application's own Approval channel.
import { afterEach, describe, expect, test } from "bun:test";
import {
  type Approvals,
  defineMitome,
  firstPartyExecutionLimits,
  type LocalTools,
  localTools,
  loop,
  makeApprovals,
  makeProvider,
  reportModelRequest,
  Turn,
  withModelRequestAccounting,
} from "@mitome/core";
import { BoxRenderable } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Match,
  Option,
  Schema,
  Scope,
  Stream,
} from "effect";
import { LanguageModel, Prompt, type Response, Tool, Toolkit } from "effect/ai";
import { runTerminal } from "../src/index.js";

const Charge = Tool.make("charge", {
  parameters: Schema.Struct({ cents: Schema.FiniteFromString, memo: Schema.String }),
  success: Schema.String,
  failureMode: "return",
  needsApproval: true,
});
const Kit = Toolkit.make(Charge);
class Channel extends Context.Service<Channel, Approvals>()("test/Approvals") {}
class Tools extends Context.Service<Tools, LocalTools<Toolkit.Tools<typeof Kit>>>()("test/Tools") {}

class Unparseable extends Schema.TaggedError<Unparseable>()("Unparseable", {}) {
  override get message() {
    return "unparseable input";
  }
}
class Unrenderable extends Schema.TaggedError<Unrenderable>()("Unrenderable", {}) {
  override get message() {
    return "cannot render";
  }
}

const finish: Response.FinishPartEncoded = {
  type: "finish",
  reason: "stop",
  usage: { inputTokens: {}, outputTokens: {} },
};

/**
 * Replies to the last user text: `charge` asks for one Tool Call first, `hold` is answered by the
 * program itself, and anything else is echoed.
 */
const model = withModelRequestAccounting(
  "test",
  Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: (options) =>
        Effect.gen(function* () {
          yield* reportModelRequest;
          const last = options.prompt.content.at(-1);
          const user = options.prompt.content.findLast((message) => message.role === "user");
          const said = user?.content
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("");
          if (said === "charge" && last?.role === "user") {
            return [
              {
                type: "tool-call",
                id: "call-1",
                name: "charge",
                params: { cents: "250", memo: "coffee \u001b[31m" },
              },
              { ...finish, reason: "tool-calls" },
            ];
          }
          const reply = last?.role === "tool" ? "tool done" : `echo ${said}`;
          return [{ type: "text", text: reply }, finish];
        }),
      streamText: () => Stream.die(new Error("not streamed")),
    }),
  ),
);

interface Reply {
  readonly reply: string;
  readonly turn: string;
}

let setup: TestRendererSetup | undefined;
let scope: Scope.Closeable | undefined;
afterEach(async () => {
  setup?.renderer.destroy();
  if (scope !== undefined) await Effect.runPromise(Scope.close(scope, Exit.void));
  setup = undefined;
  scope = undefined;
});

/** Acquires the application once, allocates its one Session and starts the terminal over it. */
const start = async (channel: "granted" | "none" | "broken" | "defective" | "held" = "granted") => {
  const dispatched: Array<unknown> = [];
  const returned: Array<Reply> = [];
  const renderedResults: Array<Reply> = [];
  const release = Deferred.makeUnsafe<void>();
  const app = defineMitome({
    program: (input: { readonly text: string }) =>
      Effect.gen(function* () {
        const turn = yield* Turn;
        if (input.text === "fail") return yield* new Unrenderable();
        if (input.text === "hold") {
          // Cleanup that keeps running after interruption until the test releases it.
          yield* Effect.addFinalizer(() => Deferred.await(release));
          return yield* Effect.never;
        }
        yield* turn.stage(Prompt.userMessage({ content: [Prompt.textPart({ text: input.text })] }));
        const approvals = yield* Channel;
        const result = yield* loop({ tools: yield* Tools, consent: approvals.consent });
        const reply: Reply = { reply: result.response.text, turn: turn.id };
        returned.push(reply);
        return reply;
      }),
    limits: firstPartyExecutionLimits,
    infrastructure: Layer.mergeAll(
      Layer.effect(Channel, makeApprovals),
      Layer.effect(
        Tools,
        localTools(
          Kit,
          Kit.of({ charge: (params) => Effect.sync(() => (dispatched.push(params), "charged")) }),
        ),
      ),
    ),
    providers: [makeProvider("test", ["echo"], undefined, () => model)],
    defaultModel: "test/echo",
    cli: {
      // `throw-parse` and `throw-render` throw instead of returning a failing Effect.
      parseInput: (text: string) => {
        if (text === "throw-parse") throw new Error("parser threw");
        return text === "unparseable" ? Effect.fail(new Unparseable()) : Effect.succeed({ text });
      },
      renderResult: (result) => {
        renderedResults.push(result);
        if (result.reply === "echo throw-render") throw new Error("renderer threw");
        return result.reply === "echo unrenderable"
          ? Effect.fail(new Unrenderable())
          : Effect.succeed(`reply: ${result.reply}`);
      },
      approvals: Channel,
    },
  });
  const cli = app.cli!;
  const owner = Scope.makeUnsafe();
  scope = owner;
  const application = await Effect.runPromise(app.acquire().pipe(Scope.provide(owner)));
  const session = await Effect.runPromise(application.session);
  const approvals = Match.value(channel).pipe(
    Match.when("granted", () => Effect.runSync(application.provide(cli.approvals!))),
    Match.when("none", () => undefined),
    Match.when("broken", () => ({ pending: Effect.die(new Error("view broke")) })),
    // A request whose decision is itself defective.
    Match.when("defective", () => ({
      pending: Effect.succeed([
        {
          turnId: "t",
          toolCallId: "c",
          name: "charge",
          params: {},
          decide: (): Effect.Effect<"accepted" | "stale"> => {
            throw new Error("decide threw");
          },
        },
      ]),
    })),
    // A read that never answers and whose interruption never finishes cleaning up.
    Match.when("held", () => ({ pending: Effect.never.pipe(Effect.ensuring(Effect.never)) })),
    Match.exhaustive,
  );
  setup = await createTestRenderer({ width: 90, height: 40 });
  const terminal = Effect.runFork(
    runTerminal(
      {
        parseInput: (text) => application.provide(cli.parseInput(text)),
        run: session.run,
        renderResult: (result) => application.provide(cli.renderResult(result)),
        history: session.history,
        turns: session.turns,
        approvals,
      },
      setup.renderer,
    ).pipe(Scope.provide(owner)),
  );
  return { setup, terminal, session, dispatched, returned, renderedResults, release };
};

/** Renders until a frame satisfies `predicate`; async Turn work does not schedule renders itself. */
const frameWith = async (predicate: (frame: string) => boolean) => {
  let frame = "";
  for (let attempt = 0; attempt < 300; attempt++) {
    await setup!.renderOnce();
    frame = setup!.captureCharFrame();
    if (predicate(frame)) return frame;
    await Bun.sleep(10);
  }
  throw new Error(`No frame matched; last frame:\n${frame}`);
};

/** The terminal's Exit, or "running" if it has not ended within `millis`. */
const settled = (terminal: Fiber.Fiber<void, unknown>, millis = 2_000) =>
  Effect.runPromise(
    Fiber.await(terminal).pipe(
      Effect.timeoutOption(millis),
      Effect.map(Option.getOrElse(() => "running" as const)),
    ),
  );

const send = async (text: string) => {
  await setup!.mockInput.pasteBracketedText(text);
  setup!.mockInput.pressEnter({ meta: true });
};

const focused = () => setup!.renderer.currentFocusedRenderable?.id;

describe("runTerminal", () => {
  test("runs repeated Turns of one Session from multiline input through the explicit mappings", async () => {
    const { session, returned, renderedResults } = await start();
    expect(focused()).toBe("message");
    await send("first\nsecond");
    await frameWith((frame) => frame.includes("reply: echo first"));
    await send("again");
    const frame = await frameWith((frame) => frame.includes("reply: echo again"));
    expect(frame).toContain("first");
    expect(frame).toContain("second");
    expect(frame).toContain("succeeded; conversation committed");
    expect(frame).toContain("4 committed messages");
    expect(focused()).toBe("message");
    // The renderer got the program's own result object; nothing was serialized in between.
    expect(renderedResults).toHaveLength(2);
    expect(renderedResults[0]).toBe(returned[0]);
    const turns = await Effect.runPromise(session.turns);
    expect(turns.map((turn) => turn.phase)).toEqual(["committed", "committed"]);
    // Only the program staged Messages: the rendered output is not in the conversation.
    const history = await Effect.runPromise(session.history);
    expect(JSON.stringify(history)).not.toContain("reply:");
  });

  test("parse, program and render failures are distinct, and nothing is rerun", async () => {
    const { session, returned } = await start();
    await send("unparseable");
    await frameWith((frame) => frame.includes("Not run: the input could not be parsed"));
    expect(await Effect.runPromise(session.turns)).toEqual([]);
    await send("fail");
    await frameWith((frame) => frame.includes("failed: cannot render;"));
    await send("unrenderable");
    const frame = await frameWith((frame) => frame.includes("could not be rendered"));
    expect(frame).toContain("it is not rerun");
    expect(returned).toHaveLength(1);
    expect((await Effect.runPromise(session.turns)).map((turn) => turn.phase)).toEqual([
      "failed",
      "committed",
    ]);
  });

  test("shows the exact prepared call; only y with the Approval focused dispatches it", async () => {
    const { dispatched } = await start();
    await send("charge");
    const prompt = await frameWith((frame) => frame.includes("Approval required"));
    expect(prompt).toContain("Tool charge");
    expect(prompt).toContain("Tool call call-1");
    expect(prompt).toContain("cents: 250");
    // The control character in the decoded memo is shown escaped, never sent to the terminal.
    expect(prompt).toContain("\\x1B[31m");
    expect(prompt).toContain("Awaiting approval");
    // Typing and pasting into the editor authorizes nothing.
    setup!.mockInput.pressKey("y");
    await setup!.mockInput.pasteBracketedText("y");
    await Bun.sleep(150);
    expect(dispatched).toEqual([]);
    expect(focused()).toBe("message");
    setup!.mockInput.pressTab();
    expect(focused()).toBe("approval");
    await frameWith((frame) => frame.includes("y approve • n deny"));
    setup!.mockInput.pressKey("y");
    const frame = await frameWith((frame) => frame.includes("reply: tool done"));
    expect(frame).toContain("Approved charge (call-1).");
    expect(frame).not.toContain("Approval required");
    expect(dispatched).toEqual([{ cents: 250, memo: "coffee \u001b[31m" }]);
    expect(focused()).toBe("message");
  });

  test("a denial is recorded apart from the Turn's own outcome and dispatches nothing", async () => {
    const { dispatched } = await start();
    await send("charge");
    await frameWith((frame) => frame.includes("Approval required"));
    setup!.mockInput.pressTab();
    setup!.mockInput.pressKey("n");
    const frame = await frameWith((frame) => frame.includes("reply: tool done"));
    expect(frame).toContain("Denied charge (call-1); the program decides how the Turn continues.");
    expect(frame).toContain("succeeded; conversation committed");
    expect(dispatched).toEqual([]);
  });

  test("without a granted channel the terminal offers no decision", async () => {
    const { dispatched } = await start("none");
    await send("charge");
    await Bun.sleep(300);
    const frame = await frameWith((frame) => frame.includes("Running"));
    expect(frame).not.toContain("Approval required");
    setup!.mockInput.pressTab();
    setup!.mockInput.pressKey("y");
    await Bun.sleep(150);
    expect(dispatched).toEqual([]);
  });

  test("Escape interrupts the Turn and reports cleanup until it actually settles", async () => {
    const { session, release } = await start();
    await send("hold");
    await frameWith((frame) => frame.includes("Running"));
    setup!.mockInput.pressEscape();
    await frameWith((frame) => frame.includes("Interrupt requested; cleanup continuing"));
    await send("queued draft");
    // A second submission is refused while the first settles, and its draft is kept.
    const busy = await frameWith((frame) => frame.includes("your draft is kept"));
    expect(busy).toContain("queued draft");
    expect((await Effect.runPromise(session.turns)).map((turn) => turn.phase)).toEqual(["running"]);
    Effect.runSync(Deferred.succeed(release, undefined));
    const frame = await frameWith((frame) =>
      frame.includes("interrupted; committed conversation unchanged"),
    );
    expect(frame).toContain("Ready");
    expect(focused()).toBe("message");
  });

  test("Ctrl-C closes the terminal without waiting for a Turn held in cleanup", async () => {
    const { terminal, session, release } = await start();
    await send("hold");
    await frameWith((frame) => frame.includes("Running"));
    setup!.mockInput.pressCtrlC();
    const exit = await Effect.runPromise(Fiber.await(terminal));
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(setup!.renderer.isDestroyed).toBe(true);
    // The Turn is still running; the caller's shutdown, not the terminal, settles it.
    expect((await Effect.runPromise(session.turns)).map((turn) => turn.phase)).toEqual(["running"]);
    Effect.runSync(Deferred.succeed(release, undefined));
  });

  test("a mapping that throws is that stage's failure: no Turn, or committed and not rerun", async () => {
    const { terminal, session, returned } = await start();
    await send("throw-parse");
    await frameWith((frame) => frame.includes("Not run: the input could not be parsed: defect:"));
    expect(await Effect.runPromise(session.turns)).toEqual([]);
    await send("throw-render");
    const frame = await frameWith((frame) => frame.includes("renderer threw"));
    expect(frame).toContain("could not be rendered (it is not rerun): defect:");
    expect(returned).toHaveLength(1);
    expect((await Effect.runPromise(session.turns)).map((turn) => turn.phase)).toEqual([
      "committed",
    ]);
    expect(await settled(terminal, 200)).toBe("running");
  });

  test("a failed frame ends the terminal with that failure and destroys the renderer", async () => {
    const { terminal } = await start();
    const broken = new BoxRenderable(setup!.renderer, {
      renderBefore: () => {
        throw new Error("frame broke");
      },
    });
    setup!.renderer.root.add(broken);
    await setup!.renderOnce();
    const exit = await settled(terminal);
    expect(
      exit !== "running" && Exit.isFailure(exit) ? Cause.pretty(exit.cause) : String(exit),
    ).toContain("frame broke");
    expect(setup!.renderer.isDestroyed).toBe(true);
  });

  test("a defective decision ends the terminal instead of being lost", async () => {
    const { terminal } = await start("defective");
    await frameWith((frame) => frame.includes("Approval required"));
    setup!.mockInput.pressTab();
    setup!.mockInput.pressKey("y");
    const exit = await settled(terminal);
    expect(
      exit !== "running" && Exit.isFailure(exit) ? Cause.pretty(exit.cause) : String(exit),
    ).toContain("decide threw");
    expect(setup!.renderer.isDestroyed).toBe(true);
  });

  test("Ctrl-C ends the terminal without waiting for a pending read held in cleanup", async () => {
    const { terminal } = await start("held");
    await frameWith((frame) => frame.includes("Ready"));
    // Let the poll start its held read.
    await Bun.sleep(50);
    setup!.mockInput.pressCtrlC();
    const exit = await settled(terminal);
    expect(exit !== "running" && Exit.isSuccess(exit)).toBe(true);
    expect(setup!.renderer.isDestroyed).toBe(true);
    // Closing the owner would wait on that cleanup forever; the caller's deadline bounds it.
    scope = undefined;
  });

  test("a failure in the view ends the terminal with it and destroys the renderer", async () => {
    const { terminal } = await start("broken");
    const exit = await Effect.runPromise(Fiber.await(terminal));
    expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "succeeded").toContain("view broke");
    expect(setup!.renderer.isDestroyed).toBe(true);
  });
});
