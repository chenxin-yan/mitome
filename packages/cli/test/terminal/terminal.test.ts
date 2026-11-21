// The real OpenTUI test renderer driving `runTerminal` over a real acquired Configuration: a native
// Session, scripted Model, registered Tools and the terminal's own Approval channel as its Approver.
import { afterEach, describe, expect, test } from "bun:test";
import {
  Agent,
  Mitome,
  Provider,
  reportModelRequest,
  Turn,
  withModelRequestAccounting,
} from "@mitome/core";
import { type LocalTools, localTools, loop, step } from "@mitome/core/kernel";
import { BoxRenderable, TextareaRenderable, TextRenderable } from "@opentui/core";
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
import { makeApprovals } from "../../src/terminal/approvals.ts";
import { runTerminal } from "../../src/terminal/terminal.ts";

const Charge = Tool.make("charge", {
  parameters: Schema.Struct({
    cents: Schema.FiniteFromString,
    memo: Schema.String,
    to: Schema.URLFromString,
  }),
  success: Schema.String,
  failureMode: "return",
  needsApproval: true,
});
const Kit = Toolkit.make(Charge);
class Tools extends Context.Service<Tools, LocalTools<Toolkit.Tools<typeof Kit>>>()("test/Tools") {}

class Unparseable extends Schema.TaggedError<Unparseable, { readonly brand: unique symbol }>()(
  "Unparseable",
  {},
) {
  override get message() {
    return "unparseable input";
  }
}
class Unrenderable extends Schema.TaggedError<Unrenderable, { readonly brand: unique symbol }>()(
  "Unrenderable",
  {},
) {
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
                params: {
                  cents: "250",
                  memo: "coffee \u001b[31m\u009b",
                  to: "https://pay.example/a?b=c",
                },
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
  await setup?.dispose();
  if (scope !== undefined) await Effect.runPromise(Scope.close(scope, Exit.void));
  setup = undefined;
  scope = undefined;
});

/**
 * Acquires the Configuration once, allocates its one Session, runs a Turn for each of `earlier`
 * and starts the terminal over it, naming the conversation with `conversation`.
 */
const start = async (
  channel: "granted" | "broken" | "defective" | "held" | "replaced" = "granted",
  closed?: Promise<void>,
  conversation?: string,
  earlier: ReadonlyArray<string> = [],
) => {
  const dispatched: Array<unknown> = [];
  const returned: Array<Reply> = [];
  const renderedResults: Array<Reply> = [];
  const release = Deferred.makeUnsafe<void>();
  const decided: Array<string> = [];
  const request = (toolCallId: string) => ({
    turnId: "t",
    toolCallId,
    name: "charge",
    params: {},
    decide: () => Effect.sync(() => (decided.push(toolCallId), "accepted" as const)),
  });
  const replaced = { decided, current: request("first"), next: request("second") };
  const agent = Agent.make({
    program: (input: { readonly text: string }) =>
      Effect.gen(function* () {
        const turn = yield* Turn;
        if (input.text === "fail") return yield* new Unrenderable();
        // A failure value with no string form.
        if (input.text === "fail-bare") return yield* Effect.fail(Object.create(null));
        // Succeeds without staging anything.
        if (input.text.startsWith("silent")) return { reply: input.text, turn: turn.id };
        if (input.text === "hold") {
          // Cleanup that keeps running after interruption until the test releases it.
          yield* Effect.addFinalizer(() => Deferred.await(release));
          return yield* Effect.never;
        }
        yield* turn.stage(Prompt.userMessage({ content: [Prompt.textPart({ text: input.text })] }));
        if (input.text === "step then hold") {
          yield* step();
          return yield* Effect.never;
        }
        const result = yield* loop({ tools: yield* Tools });
        const reply: Reply = { reply: result.response.text, turn: turn.id };
        returned.push(reply);
        return reply;
      }),
    text: {
      // `throw-parse` and `throw-render` throw instead of returning a failing Effect.
      parse: (text: string) => {
        if (text === "throw-parse") throw new Error("parser threw");
        return text === "unparseable" ? Effect.fail(new Unparseable()) : Effect.succeed({ text });
      },
      render: (result) => {
        renderedResults.push(result);
        if (result.reply === "echo throw-render") throw new Error("renderer threw");
        return result.reply === "echo unrenderable" || result.reply === "silent unrenderable"
          ? Effect.fail(new Unrenderable())
          : Effect.succeed(`reply: ${result.reply}`);
      },
    },
  });
  const tools = Layer.effect(
    Tools,
    localTools(
      Kit,
      Kit.of({ charge: (params) => Effect.sync(() => (dispatched.push(params), "charged")) }),
    ),
  );
  const config = Mitome.make({
    agent,
    provide: tools,
    providers: [Provider.make("test", { modelIds: ["echo"], provision: () => model })],
    model: "test/echo",
  });
  const owner = Scope.makeUnsafe();
  scope = owner;
  const instance = await Effect.runPromise(config.acquire().pipe(Scope.provide(owner)));
  const session = await Effect.runPromise(instance.session());
  for (const text of earlier) await Effect.runPromise(session.run({ text }));
  const granted = Effect.runSync(makeApprovals);
  const approvals = Match.value(channel).pipe(
    Match.when("granted", () => granted),
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
    // The shown request is replaced by another without any read in between finding none.
    Match.when("replaced", () => ({ pending: Effect.sync(() => [replaced.current]) })),
    // A read that never answers and whose interruption keeps cleaning up until `release`.
    Match.when("held", () => ({
      pending: Effect.never.pipe(Effect.ensuring(Deferred.await(release))),
    })),
    Match.exhaustive,
  );
  setup = await createTestRenderer({ width: 90, height: 40 });
  // Stands in for how the renderer's own close settles.
  if (closed !== undefined) {
    Object.defineProperty(setup.renderer, "closed", { value: closed, configurable: true });
  }
  const terminal = Effect.runFork(
    runTerminal(
      {
        parseInput: (text) => instance.provide(config.text.parse(text)),
        run: (input) => granted.provideApprover(session.run(input)),
        renderResult: (result) => instance.provide(config.text.render(result)),
        history: session.history,
        turns: session.turns,
        approvals,
        conversation,
      },
      setup.renderer,
    ).pipe(Scope.provide(owner)),
  );
  return { setup, terminal, session, dispatched, returned, renderedResults, release, replaced };
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

/** The whole text of a renderable, including what its box scrolls out of the frame. */
const textOf = (id: string) => {
  const found = setup!.renderer.root.findDescendantById(id);
  if (found instanceof TextareaRenderable) return found.plainText;
  const [text] = found?.getChildren() ?? [];
  return text instanceof TextRenderable ? text.plainText : "";
};

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
    expect(turns.map((turn) => turn.phase)).toEqual(["succeeded", "succeeded"]);
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
      "succeeded",
    ]);
  });

  test("shows the exact prepared call; only y with the Approval focused dispatches it", async () => {
    const { dispatched } = await start();
    await send("charge");
    const prompt = await frameWith((frame) => frame.includes("Approval required"));
    expect(prompt).toContain("Tool charge");
    expect(prompt).toContain("Tool call call-1");
    // The JSON the Model sent, not the number and URL the schema decodes from it; control
    // characters are shown escaped, never sent to the terminal.
    expect(textOf("approval")).toContain(
      '"cents": "250",\n  "memo": "coffee \\u001b[31m\\u009b",\n  "to": "https://pay.example/a?b=c"',
    );
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
    expect(dispatched).toEqual([
      { cents: 250, memo: "coffee \u001b[31m\u009b", to: expect.any(URL) },
    ]);
    expect(JSON.stringify(dispatched)).toContain('"to":"https://pay.example/a?b=c"');
    expect(focused()).toBe("message");
  });

  test("dismissing a focused Approval returns focus to the editor", async () => {
    await start();
    await send("charge");
    await frameWith((frame) => frame.includes("Approval required"));
    setup!.mockInput.pressTab();
    expect(focused()).toBe("approval");
    setup!.mockInput.pressEscape();
    await frameWith(
      (frame) => frame.includes("interrupted;") && !frame.includes("Approval required"),
    );
    expect(focused()).toBe("message");
    await setup!.mockInput.typeText("after");
    expect(textOf("message")).toBe("after");
  });

  test("replacing a focused Approval's request returns focus, so y does not decide the new one", async () => {
    const { replaced } = await start("replaced");
    await frameWith((frame) => frame.includes("Tool call first"));
    setup!.mockInput.pressTab();
    expect(focused()).toBe("approval");
    replaced.current = replaced.next;
    await frameWith((frame) => frame.includes("Tool call second"));
    setup!.mockInput.pressKey("y");
    await Bun.sleep(150);
    expect(replaced.decided).toEqual([]);
    expect(focused()).toBe("message");
  });

  test("says a Turn that staged nothing left the conversation unchanged", async () => {
    await start();
    await send("silent");
    const frame = await frameWith((frame) => frame.includes("reply: silent"));
    expect(frame).toContain("succeeded; conversation unchanged");

    // The outcome line says whether history changed; the render failure only that the Turn ran.
    await send("silent unrenderable");
    const unrendered = await frameWith((frame) => frame.includes("could not be rendered"));
    expect(unrendered).toContain(
      "The Turn succeeded, but its result could not be rendered (it is not rerun)",
    );
  });

  test("a failure value with no string form is shown and the terminal keeps running", async () => {
    const { terminal } = await start();
    await send("fail-bare");
    await frameWith((frame) => frame.includes("failed: {};"));
    expect(await settled(terminal, 200)).toBe("running");
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
    const frame = await frameWith((frame) => frame.includes("interrupted; kept 0 Entries"));
    expect(frame).toContain("Ready");
    expect(focused()).toBe("message");
  });

  test("says how many Steps an interrupted Turn kept", async () => {
    const { session } = await start();
    await send("step then hold");
    await frameWith((frame) => frame.includes("Running"));
    // The Step's Entry is committed while the program still runs.
    for (let attempt = 0; attempt < 300; attempt++) {
      if ((await Effect.runPromise(session.history)).length === 2) break;
      await Bun.sleep(10);
    }
    setup!.mockInput.pressEscape();
    const frame = await frameWith((frame) => frame.includes("interrupted; kept 1 Entry."));
    expect(frame).toContain("2 committed messages");
  });

  test("names the conversation and counts a continued one's Messages from the start", async () => {
    await start("granted", undefined, "Continued conversation c-1 (1 Entry).", ["earlier"]);
    const frame = await frameWith((frame) => frame.includes("Ready"));
    expect(frame).toContain("Continued conversation c-1 (1 Entry).");
    expect(frame).toContain("2 committed messages");
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
      "succeeded",
    ]);
    expect(await settled(terminal, 200)).toBe("running");
  });

  test("the renderer's own destruction closes the terminal successfully", async () => {
    const { terminal } = await start();
    await frameWith((frame) => frame.includes("Ready"));
    setup!.renderer.destroy();
    const exit = await settled(terminal);
    expect(exit !== "running" && Exit.isSuccess(exit)).toBe(true);
  });

  test("a close that fails ends the terminal with that failure, not as a user close", async () => {
    const failure = Promise.withResolvers<void>();
    const { terminal } = await start("granted", failure.promise);
    await frameWith((frame) => frame.includes("Ready"));
    failure.reject(new Error("output failed"));
    const exit = await settled(terminal);
    expect(
      exit !== "running" && Exit.isFailure(exit) ? Cause.pretty(exit.cause) : String(exit),
    ).toContain("output failed");
    expect(setup!.renderer.isDestroyed).toBe(true);
    // Let teardown wait for the renderer's real close.
    Reflect.deleteProperty(setup!.renderer, "closed");
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
    const { terminal, release } = await start("held");
    try {
      await frameWith((frame) => frame.includes("Ready"));
      // Let the poll start its held read.
      await Bun.sleep(50);
      setup!.mockInput.pressCtrlC();
      const exit = await settled(terminal);
      expect(exit !== "running" && Exit.isSuccess(exit)).toBe(true);
      expect(setup!.renderer.isDestroyed).toBe(true);
    } finally {
      Effect.runSync(Deferred.succeed(release, undefined));
    }
  });

  test("a failure in the view ends the terminal with it and destroys the renderer", async () => {
    const { terminal } = await start("broken");
    const exit = await Effect.runPromise(Fiber.await(terminal));
    expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "succeeded").toContain("view broke");
    expect(setup!.renderer.isDestroyed).toBe(true);
  });
});
