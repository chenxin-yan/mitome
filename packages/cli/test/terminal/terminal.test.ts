// The real OpenTUI test renderer driving `runTerminal` over a real acquired Configuration: a native
// Session, scripted Model, registered Tools and the terminal's own Approval channel as its Approver.
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  Agent,
  Command,
  Extension,
  Mitome,
  Provider,
  reportModelRequest,
  Turn,
  withModelRequestAccounting,
} from "@mitome/core";
import { localTools, loop, step } from "@mitome/core/kernel";
import type { LocalTools } from "@mitome/core/kernel";
import { terminal } from "@mitome/core/terminal";
import type { Options } from "@mitome/core/terminal";
import { BoxRenderable, TextareaRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { TestRendererSetup } from "@opentui/core/testing";
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
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai";
import type { Response } from "effect/ai";
import { makeApprovals } from "../../src/terminal/approvals.ts";
import { conversations } from "../../src/terminal/conversations.ts";
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

/** How many Model requests were made since the last `start`. */
let modelRequests = 0;

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
          modelRequests += 1;
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

/** Commands that reply, prompt and fail, none of which needs the Model. */
const notes = Extension.make("notes", {
  commands: [
    Command.make("todos", {
      description: "Show the todo list",
      run: () => Effect.succeed(Command.reply("1. write the tests")),
    }),
    Command.make("plan", {
      description: "Plan the work",
      run: (input) => Effect.succeed(Command.prompt(`plan: ${input}`)),
    }),
    Command.make("broken", {
      description: "Fail",
      run: () => Effect.fail("broken on purpose"),
    }),
  ],
});

/** A Command that replies with its own name. */
const named = (name: string) =>
  Command.make(name, {
    description: `Reply ${name}`,
    run: () => Effect.succeed(Command.reply(name)),
  });

/**
 * An Extension whose setup in the Session it starts `n`-th adds `lists[n]` as its Commands; in the
 * first Session, its release waits for `held`. `released` counts the Sessions it was released in.
 */
const rotating = (
  lists: ReadonlyArray<ReadonlyArray<Command.Command>>,
  held?: Deferred.Deferred<void>,
) => {
  const released: Array<number> = [];
  let started = 0;
  const extension = Extension.make(
    "rotating",
    Effect.gen(function* () {
      const n = started++;
      yield* Effect.addFinalizer(() =>
        Effect.andThen(
          n === 0 && held !== undefined ? Deferred.await(held) : Effect.void,
          Effect.sync(() => void released.push(n)),
        ),
      );
      return { commands: lists[n] ?? [] };
    }),
  );
  return { extension, released };
};

/** The starter keys `mitome init` writes, and keys that type Commands. */
const starterKeys = {
  enter: terminal.submit,
  "shift+enter": terminal.newline,
  "ctrl+j": terminal.newline,
  escape: terminal.interrupt,
  "ctrl+d": "/quit",
  "ctrl+t": "/todos",
  "ctrl+p": "/plan the release",
} satisfies Options["keys"];

let setup: TestRendererSetup | undefined;
let scope: Scope.Closeable | undefined;
afterEach(async () => {
  await setup?.dispose();
  if (scope !== undefined) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
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
  {
    keys = starterKeys,
    kittyKeyboard = false,
    use = [],
    width = 90,
    height = 40,
  }: {
    readonly keys?: Options["keys"];
    readonly kittyKeyboard?: boolean;
    readonly use?: ReadonlyArray<Extension.Extension>;
    readonly width?: number;
    readonly height?: number;
  } = {},
) => {
  modelRequests = 0;
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
    use: [notes, ...use],
    program: (input: { readonly text: string }) =>
      Effect.gen(function* () {
        const turn = yield* Turn;
        if (input.text === "fail") {
          return yield* new Unrenderable();
        }
        // A failure value with no string form.
        if (input.text === "fail-bare") {
          return yield* Effect.fail(Object.create(null));
        }
        // Succeeds without staging anything.
        if (input.text.startsWith("silent")) {
          return { reply: input.text, turn: turn.id };
        }
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
        if (text === "throw-parse") {
          throw new Error("parser threw");
        }
        return text === "unparseable" ? Effect.fail(new Unparseable()) : Effect.succeed({ text });
      },
      render: (result) => {
        renderedResults.push(result);
        if (result.reply === "echo throw-render") {
          throw new Error("renderer threw");
        }
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
  for (const text of earlier) {
    await Effect.runPromise(session.run({ text }));
  }
  // `/new` replaces it, as the CLI does.
  const sessions = conversations(
    { session, conversation },
    Effect.map(instance.session(), (next) => ({
      session: next,
      conversation: `Conversation ${next.transcript}.`,
    })),
  );
  const current = () => sessions.current().session;
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
  setup = await createTestRenderer({ width, height, kittyKeyboard });
  // Stands in for how the renderer's own close settles.
  if (closed !== undefined) {
    Object.defineProperty(setup.renderer, "closed", { value: closed, configurable: true });
  }
  const terminal = Effect.runFork(
    runTerminal(
      {
        parseInput: (text) => instance.provide(config.text.parse(text)),
        run: (input) => Effect.suspend(() => granted.provideApprover(current().run(input))),
        renderResult: (result) => instance.provide(config.text.render(result)),
        history: Effect.suspend(() => current().history),
        turns: Effect.suspend(() => current().turns),
        approvals,
        current: sessions.current,
        keys: new Map(Object.entries(keys)),
        command: (name, input) => Effect.suspend(() => current().command(name, input)),
        newConversation: sessions.newConversation,
      },
      setup.renderer,
    ).pipe(Scope.provide(owner)),
  );
  return {
    setup,
    terminal,
    session,
    current,
    dispatched,
    returned,
    renderedResults,
    release,
    replaced,
  };
};

/** Renders until a frame satisfies `predicate`; async Turn work does not schedule renders itself. */
const frameWith = async (predicate: (frame: string) => boolean) => {
  let frame = "";
  for (let attempt = 0; attempt < 300; attempt++) {
    await setup!.renderOnce();
    frame = setup!.captureCharFrame();
    if (predicate(frame)) {
      return frame;
    }
    await Bun.sleep(10);
  }
  throw new Error(`No frame matched; last frame:\n${frame}`);
};

/** The terminal's Exit, or "running" if it has not ended within `millis`. */
const settled = (terminal: Fiber.Fiber<void, unknown>, millis = 2000) =>
  Effect.runPromise(
    Fiber.await(terminal).pipe(
      Effect.timeoutOption(millis),
      Effect.map(Option.getOrElse(() => "running" as const)),
    ),
  );

const send = async (text: string) => {
  await setup!.mockInput.pasteBracketedText(text);
  setup!.mockInput.pressEnter();
};

const focused = () => setup!.renderer.currentFocusedRenderable?.id;

/** The whole text of a renderable, including what its box scrolls out of the frame. */
const textOf = (id: string) => {
  const found = setup!.renderer.root.findDescendantById(id);
  if (found instanceof TextareaRenderable) {
    return found.plainText;
  }
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
      if ((await Effect.runPromise(session.history)).length === 2) {
        break;
      }
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

describe("runTerminal keys and Commands", () => {
  const history = (session: { readonly history: Effect.Effect<ReadonlyArray<unknown>, unknown> }) =>
    Effect.runPromise(session.history);

  test("only a bound key sends: the editor's own Enter and Alt-Enter do nothing", async () => {
    const { session } = await start(undefined, undefined, undefined, undefined, {
      keys: { "ctrl+s": terminal.submit },
    });
    await frameWith((frame) => frame.includes("ctrl+s send"));
    await setup!.mockInput.typeText("hello");
    setup!.mockInput.pressEnter();
    setup!.mockInput.pressEnter({ meta: true });
    setup!.mockInput.pressKey("LINEFEED");
    await Bun.sleep(150);
    expect(textOf("message")).toBe("hello");
    expect(await Effect.runPromise(session.turns)).toEqual([]);
    setup!.mockInput.pressKey("s", { ctrl: true });
    await frameWith((frame) => frame.includes("reply: echo hello"));
    expect(textOf("message")).toBe("");
  });

  for (const kittyKeyboard of [false, true]) {
    test(`ctrl+j makes a new line ${kittyKeyboard ? "from the protocol's Ctrl+J" : "from a line feed"}`, async () => {
      await start(undefined, undefined, undefined, undefined, { kittyKeyboard });
      await setup!.mockInput.typeText("one");
      if (kittyKeyboard) {
        setup!.mockInput.pressKey("j", { ctrl: true });
      }
      // Without the protocol a terminal sends Ctrl+J as a line feed.
      else {
        setup!.mockInput.pressKey("LINEFEED");
      }
      await setup!.mockInput.typeText("two");
      expect(textOf("message")).toBe("one\ntwo");
      // Enter is bound to send, so it never breaks a line.
      setup!.mockInput.pressEnter();
      await frameWith((frame) => frame.includes("reply: echo one"));
    });
  }

  test("ctrl+j makes a new line on a non-Latin layout, from the key's base-layout code", async () => {
    await start(undefined, undefined, undefined, undefined, { kittyKeyboard: true });
    await setup!.mockInput.typeText("one");
    // Ctrl+J on a Cyrillic layout: the layout's letter о (1086), and J (106) as its base key.
    setup!.mockInput.pressKey("\u001b[1086::106;5u");
    await setup!.mockInput.typeText("two");
    expect(textOf("message")).toBe("one\ntwo");
  });

  test("with the enhanced keyboard protocol, Shift+Enter makes a new line and Enter sends", async () => {
    await start(undefined, undefined, undefined, undefined, { kittyKeyboard: true });
    await setup!.mockInput.typeText("one");
    setup!.mockInput.pressEnter({ shift: true });
    await setup!.mockInput.typeText("two");
    expect(textOf("message")).toBe("one\ntwo");
    setup!.mockInput.pressEnter();
    await frameWith((frame) => frame.includes("reply: echo one"));
  });

  test("without the protocol, Shift+Enter arrives as Enter and sends", async () => {
    await start();
    await setup!.mockInput.typeText("one");
    setup!.mockInput.pressEnter({ shift: true });
    await frameWith((frame) => frame.includes("reply: echo one"));
    expect(textOf("message")).toBe("");
  });

  test("a key bound to text runs that Command and keeps the draft", async () => {
    const { session } = await start();
    await setup!.mockInput.typeText("my draft");
    setup!.mockInput.pressKey("t", { ctrl: true });
    const frame = await frameWith((frame) => frame.includes("1. write the tests"));
    expect(frame).toContain("› /todos");
    expect(frame).toContain("/todos replied (not sent to the Model):");
    expect(textOf("message")).toBe("my draft");
    // A Reply is neither sent to the Model nor kept, and runs no Turn.
    expect(modelRequests).toBe(0);
    expect(await Effect.runPromise(session.turns)).toEqual([]);
    expect(await history(session)).toEqual([]);
  });

  test("a Prompt starts a Turn with its text through the text mapping", async () => {
    const { session } = await start();
    setup!.mockInput.pressKey("p", { ctrl: true });
    const frame = await frameWith((frame) => frame.includes("reply: echo plan: the release"));
    expect(frame).toContain("› /plan the release");
    expect((await Effect.runPromise(session.turns)).map((turn) => turn.phase)).toEqual([
      "succeeded",
    ]);
    expect(JSON.stringify(await history(session))).toContain("plan: the release");
  });

  test("an unknown or failing Command shows its message and reaches no Model", async () => {
    const { session } = await start();
    await send("/nope at all");
    await frameWith((frame) => frame.includes("There is no command /nope"));
    await send("/broken");
    await frameWith((frame) => frame.includes("Command /broken failed"));
    expect(modelRequests).toBe(0);
    expect(await Effect.runPromise(session.turns)).toEqual([]);
    // Text that only starts like a Command is ordinary input.
    await send("/Plan");
    await frameWith((frame) => frame.includes("reply: echo /Plan"));
  });

  test("/quit closes the terminal as Ctrl-C does", async () => {
    const { terminal } = await start();
    await send("/quit");
    const exit = await settled(terminal);
    expect(exit !== "running" && Exit.isSuccess(exit)).toBe(true);
    expect(setup!.renderer.isDestroyed).toBe(true);
  });

  test("the key bound to /quit closes the terminal", async () => {
    const { terminal } = await start();
    await setup!.mockInput.typeText("unsent");
    setup!.mockInput.pressKey("d", { ctrl: true });
    const exit = await settled(terminal);
    expect(exit !== "running" && Exit.isSuccess(exit)).toBe(true);
  });

  test("/new ends the conversation and starts another, keeping what is on screen", async () => {
    const { session, current } = await start(undefined, undefined, "Conversation first.");
    await send("hello");
    await frameWith((frame) => frame.includes("2 committed messages"));
    await send("/new");
    const frame = await frameWith((frame) => frame.includes("Started a new conversation."));
    expect(frame).toContain("reply: echo hello");
    expect(frame).toContain(`Conversation ${current().transcript}.`);
    expect(frame).toContain("0 committed messages");
    expect(current()).not.toBe(session);
    await send("again");
    await frameWith((frame) => frame.includes("reply: echo again"));
    expect(JSON.stringify(await history(current()))).not.toContain("hello");
    expect(await Effect.runPromise(Effect.exit(session.history))).toSatisfy(Exit.isFailure);
  });

  test("after /new, the Commands listed and run are the new Session's", async () => {
    const { extension } = rotating([[named("alpha")], [named("beta")]]);
    await start(undefined, undefined, undefined, undefined, { use: [extension] });
    await setup!.mockInput.typeText("/");
    await frameWith((frame) => frame.includes("/alpha"));
    setup!.mockInput.pressBackspace();
    await send("/new");
    await frameWith((frame) => frame.includes("Started a new conversation."));
    await setup!.mockInput.typeText("/");
    const frame = await frameWith((frame) => frame.includes("/beta"));
    expect(frame).not.toContain("Reply alpha");
    setup!.mockInput.pressBackspace();
    await send("/beta");
    await frameWith((frame) => frame.includes("/beta replied"));
    await send("/alpha");
    await frameWith((frame) => frame.includes("There is no command /alpha"));
  });

  test("/new keeps the current Session when the next names a Command the terminal names", async () => {
    const { extension, released } = rotating([[named("alpha")], [named("quit")]]);
    const { session, current } = await start(undefined, undefined, "Conversation first.", [], {
      use: [extension],
    });
    await send("/new");
    const frame = await frameWith((frame) => frame.includes("Could not start a new conversation"));
    expect(frame).toContain('Extension "rotating" names a Command /quit');
    expect(released).toEqual([1]);
    expect(current()).toBe(session);
    await send("hello");
    const after = await frameWith((frame) => frame.includes("reply: echo hello"));
    expect(after).toContain("Conversation first.");
    expect(JSON.stringify(await history(session))).toContain("hello");
    await setup!.mockInput.typeText("/");
    await frameWith((frame) => frame.includes("Reply alpha"));
  });

  test("an interrupt while the previous Session closes still shows the conversation /new started", async () => {
    const held = Deferred.makeUnsafe<void>();
    const { extension, released } = rotating([[], []], held);
    const { session, current } = await start(undefined, undefined, "Conversation first.", [], {
      use: [extension],
    });
    await send("/new");
    await frameWith((frame) => frame.includes("Running a Command"));
    // The switch has happened; the previous Session is still releasing.
    for (let attempt = 0; attempt < 300 && current() === session; attempt++) {
      await Bun.sleep(10);
    }
    expect(current()).not.toBe(session);
    setup!.mockInput.pressEscape();
    await Bun.sleep(50);
    Effect.runSync(Deferred.succeed(held, undefined));
    let frame = await frameWith((frame) => frame.includes("Ready"));
    expect(released).toEqual([0]);
    expect(frame).toContain(`Conversation ${current().transcript}.`);
    expect(frame).not.toContain("Conversation first.");
    expect(frame).toContain("Started a new conversation.");
    await send("after");
    frame = await frameWith((frame) => frame.includes("reply: echo after"));
    expect(frame).toContain(`Conversation ${current().transcript}.`);
    expect(JSON.stringify(await history(current()))).toContain("after");
  });

  test("only a plain Tab moves to a pending Approval; Shift+Tab reaches its binding", async () => {
    await start(undefined, undefined, undefined, undefined, {
      keys: { ...starterKeys, "shift+tab": terminal.interrupt },
    });
    await send("charge");
    await frameWith((frame) => frame.includes("Approval required"));
    setup!.mockInput.pressTab({ shift: true });
    await frameWith(
      (frame) => frame.includes("interrupted;") && !frame.includes("Approval required"),
    );
    expect(focused()).toBe("message");
  });

  test("lists the Commands matching what follows / as it is typed", async () => {
    await start();
    await setup!.mockInput.typeText("/");
    let frame = await frameWith((frame) => frame.includes("/todos"));
    for (const line of [
      "/quit    Close the terminal",
      "/new     Start a new conversation",
      "/todos   Show the todo list",
      "/plan    Plan the work",
      "/broken  Fail",
    ]) {
      expect(frame).toContain(line);
    }
    await setup!.mockInput.typeText("pl");
    frame = await frameWith((frame) => !frame.includes("/todos"));
    expect(frame).toContain("/plan  Plan the work");
    await setup!.mockInput.typeText("x");
    frame = await frameWith((frame) => !frame.includes("Plan the work"));
    setup!.mockInput.pressBackspace();
    setup!.mockInput.pressBackspace();
    setup!.mockInput.pressBackspace();
    setup!.mockInput.pressBackspace();
    await setup!.mockInput.typeText("hello /todos");
    frame = await frameWith((frame) => frame.includes("hello /todos"));
    expect(frame).not.toContain("Show the todo list");
  });

  test("lists no more Commands than leave the editor and the footer on the screen", async () => {
    const many = Extension.make("many", {
      commands: Array.from({ length: 30 }, (_, index) =>
        named(`c${String(index).padStart(2, "0")}`),
      ),
    });
    await start(undefined, undefined, undefined, undefined, {
      use: [many],
      width: 80,
      height: 24,
    });
    await setup!.mockInput.typeText("/");
    let frame = await frameWith((frame) => frame.includes("/c00"));
    expect(frame).toContain("Message");
    expect(frame).toContain("Ready");
    expect(frame).toMatch(/and \d+ more Commands; type to narrow them/);
    expect(frame).not.toContain("/c29");
    // A smaller window fits fewer; the list gives the rows back without another keystroke.
    setup!.resize(80, 16);
    frame = await frameWith((frame) => frame.includes("Ready") && frame.includes("Message"));
    expect(frame).toMatch(/and \d+ more Commands; type to narrow them/);
    setup!.resize(80, 24);
    await setup!.mockInput.typeText("c2");
    frame = await frameWith((frame) => frame.includes("/c29"));
    expect(frame).toContain("/c20");
    expect(frame).not.toContain("more Commands");
    expect(frame).toContain("Ready");
  });

  test("refuses a Command while a Turn runs, as any submission, and keeps the draft", async () => {
    const { release } = await start();
    await send("hold");
    await frameWith((frame) => frame.includes("Running"));
    await send("/todos");
    const frame = await frameWith((frame) => frame.includes("your draft is kept"));
    expect(frame).not.toContain("1. write the tests");
    expect(textOf("message")).toBe("/todos");
    setup!.mockInput.pressKey("t", { ctrl: true });
    await Bun.sleep(100);
    expect(setup!.captureCharFrame()).not.toContain("1. write the tests");
    setup!.mockInput.pressEscape();
    Effect.runSync(Deferred.succeed(release, undefined));
    await frameWith((frame) => frame.includes("interrupted;"));
  });
});
