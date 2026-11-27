/** The terminal Host for one acquired Configuration and its current Session, on OpenTUI. */

import { type ApprovalDecision, Command, type Session } from "@mitome/core";
import { type Binding, type Control, terminal } from "@mitome/core/terminal";
import {
  BoxRenderable,
  type CliRenderer,
  createCliRenderer,
  type KeyEvent,
  ScrollBoxRenderable,
  TextareaRenderable,
  TextRenderable,
} from "@opentui/core";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Formatter,
  Match,
  Predicate,
  type Scope,
} from "effect";
import type { Prompt } from "effect/ai";
import type { ApprovalChannel, PendingApproval } from "./approvals.js";
import { isControl, keysOf } from "./keys.js";

/**
 * What the terminal runs, already bound to one acquired Configuration: its explicit input and result
 * mappings, its keys, the retained Session of the current conversation, and the Approval channel
 * whose Approver answers its Turns.
 */
export interface TerminalApplication<Input, A> {
  readonly parseInput: (text: string) => Effect.Effect<Input, unknown>;
  /** Runs one Turn of the current Session, with the Approver whose requests `approvals` shows. */
  readonly run: (input: Input) => Effect.Effect<A, unknown>;
  /** Its success must be a string; it is shown as application output, never as a Message. */
  readonly renderResult: (result: A) => Effect.Effect<unknown, unknown>;
  readonly history: Effect.Effect<ReadonlyArray<Prompt.Message>, unknown>;
  readonly turns: Effect.Effect<ReadonlyArray<Session.TurnSnapshot>, unknown>;
  readonly approvals: ApprovalChannel;
  /**
   * The conversation in use, which `/new` replaces with a new value: what names it for a person,
   * shown throughout (`undefined` when it is not kept), and every Command a person can type in it,
   * the terminal's own included, listed as `/` is typed.
   */
  readonly current: () => {
    readonly conversation: string | undefined;
    readonly commands: ReadonlyArray<{ readonly name: string; readonly description: string }>;
  };
  /** Each bound key, in `+`-notation, and what it does; only these send or break lines. */
  readonly keys: ReadonlyMap<string, Binding>;
  /** Runs one of the Session's Commands by name with the text after it. */
  readonly command: (name: string, input: string) => Effect.Effect<Command.Result, unknown>;
  /**
   * Ends the current conversation and starts a new one, which `current`, `run`, `history`, `turns`
   * and `command` then use. It can fail or be interrupted before or after it switches.
   */
  readonly newConversation: Effect.Effect<void, unknown>;
}

/** The rows of the Approval box and of the editor's box. */
const approvalRows = 10;
const editorRows = 5;

/** How often the view rereads pending Approvals; it never waits on execution. */
const refreshMillis = 100;

/** Keeps newlines and tabs; every other control character is shown escaped, never sent raw. */
const printable = (text: string) =>
  text.replace(
    // oxlint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

/** The JSON the Model sent, indented and never truncated; the box scrolls instead. */
const showParams = ({ params }: PendingApproval) => printable(JSON.stringify(params, null, 2));

const describe = (cause: unknown): string =>
  printable(
    cause instanceof Error
      ? cause.message
      : Predicate.isString(cause)
        ? cause
        : // Never throws, unlike String() on an object with no string form.
          Formatter.format(cause),
  );

/** Every reason of a Cause, so a failure mixed with interruption is never shown as only one. */
const reasons = (cause: Cause.Cause<unknown>) =>
  cause.reasons
    .map((reason) =>
      Cause.isFailReason(reason)
        ? describe(reason.error)
        : Cause.isDieReason(reason)
          ? `defect: ${describe(reason.defect)}`
          : "interrupted",
    )
    .join("; ");

const outcome = (exit: Exit.Exit<unknown, unknown>, snapshot: Session.TurnSnapshot) => {
  const kept = snapshot.entries.length;
  const conversation = Match.value(snapshot.phase).pipe(
    Match.when("succeeded", () =>
      snapshot.entries.length === 0 ? "conversation unchanged" : "conversation committed",
    ),
    // A Turn that stopped keeps each Step it completed.
    Match.when("failed", () => `kept ${kept} ${kept === 1 ? "Entry" : "Entries"}`),
    Match.when("uncertain", () => "commit outcome uncertain"),
    Match.when("running", () => "still settling"),
    Match.exhaustive,
  );
  if (Exit.isSuccess(exit)) {
    return `Turn ${snapshot.id} succeeded; ${conversation}.`;
  }
  return Cause.hasInterruptsOnly(exit.cause)
    ? `Turn ${snapshot.id} interrupted; ${conversation}.`
    : `Turn ${snapshot.id} failed: ${reasons(exit.cause)}; ${conversation}.`;
};

type Phase = "idle" | "command" | "parsing" | "running" | "rendering";

/** One submitted input and what happened to it, in order. */
interface Entry {
  readonly input: string;
  readonly lines: Array<string>;
}

/** The first key bound to `control`, if any. */
const keyFor = (keys: ReadonlyMap<string, Binding>, control: Control) =>
  [...keys].find(([, binding]) => isControl(binding, control))?.[0];

const help = (
  keys: ReadonlyMap<string, Binding>,
  phase: Phase,
  approval: PendingApproval | undefined,
  deciding: boolean,
) => {
  const interrupt = keyFor(keys, terminal.interrupt);
  return [
    approval === undefined ? undefined : deciding ? "y approve • n deny • Tab back" : "Tab decide",
    phase === "idle"
      ? `${keyFor(keys, terminal.submit)} send`
      : interrupt === undefined
        ? undefined
        : `${interrupt} interrupt`,
    "Ctrl-C close",
  ]
    .filter(Predicate.isNotUndefined)
    .join(" • ");
};

/**
 * Runs the terminal until it is closed (Ctrl-C, `/quit`, a signal, or the renderer's own
 * destruction) or fails (a failed frame, or a defect in launched work such as a decision), then
 * restores it. Submissions run one at a time as parse, one Turn, render; a stage's failure, thrown
 * or returned, is shown for that submission. A submission `Command.parse` names a Command runs it
 * instead: the terminal's own `/quit` and `/new`, or one of the Session's, whose reply is shown
 * and whose prompt is submitted as the input. Only bound keys send, break lines or interrupt. All launched work, the Approval poll included, is forked into the
 * caller's Scope, so ending never waits for it and the caller decides how to shut down. Pending Approvals are reread passively; only `y`/`n` while the
 * Approval box has focus decides the request it shows. Uses `renderer` when given, for tests.
 */
export const runTerminal = <Input, A>(
  application: TerminalApplication<Input, A>,
  renderer?: CliRenderer,
): Effect.Effect<void, Cause.UnknownError, Scope.Scope> =>
  Effect.acquireUseRelease(
    renderer === undefined
      ? Effect.tryPromise(() => createCliRenderer())
      : Effect.succeed(renderer),
    (renderer) => view(application, renderer),
    (renderer) =>
      Effect.andThen(
        Effect.sync(() => renderer.destroy()),
        closed(renderer),
      ),
  );

/**
 * Waits, when releasing the renderer, until it is destroyed and has restored the terminal, which
 * `destroy()` only starts, so a shutdown that then exits the process cannot do so first. A
 * rejection (its output failed, or closing ran late) still means closed and must not replace the
 * terminal's own outcome.
 */
const closed = (renderer: CliRenderer) =>
  Effect.promise(() => renderer.closed.catch(() => undefined));

const view = Effect.fnUntraced(function* <Input, A>(
  application: TerminalApplication<Input, A>,
  renderer: CliRenderer,
) {
  // Launched work lives in the caller's Scope; the view never awaits it, and its only failures
  // are defects (per-submission failures are captured below), which end the terminal.
  const launched = yield* FiberSet.make<unknown, never>();
  const runFork = yield* FiberSet.runtime(launched)();
  const entries: Array<Entry> = [];
  let phase: Phase = "idle";
  let interrupting = false;
  let stage: Fiber.Fiber<unknown, unknown> | undefined;
  let shown: PendingApproval | undefined;
  // A continued conversation starts with its history.
  let committed = (yield* Effect.exit(application.history)).pipe(
    Exit.match({ onFailure: () => 0, onSuccess: (history) => history.length }),
  );
  let notice = "";

  const transcript = new TextRenderable(renderer, { content: "", wrapMode: "word" });
  const scroll = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    stickyScroll: true,
    stickyStart: "bottom",
  });
  scroll.add(transcript);
  const approvalText = new TextRenderable(renderer, { content: "", wrapMode: "char" });
  const approval = new ScrollBoxRenderable(renderer, {
    id: "approval",
    border: true,
    title: "Approval required",
    height: approvalRows,
    flexShrink: 0,
    visible: false,
    onKeyDown: (key) => decideWith(key),
  });
  approval.add(approvalText);
  // Shown while the input starts with `/`: the Commands whose names begin with what follows it.
  const listing = new TextRenderable(renderer, {
    id: "commands",
    content: "",
    // One row per Command, so the rows it takes are known.
    wrapMode: "none",
    flexShrink: 0,
    visible: false,
  });
  const editor = new TextareaRenderable(renderer, {
    id: "message",
    flexGrow: 1,
    placeholder: "Type a message",
    // Only bound keys send or break lines: the editor's own keys for both become its submit,
    // which does nothing without an `onSubmit`.
    keyBindings: ["return", "kpenter", "linefeed"].flatMap((name) => [
      { name, action: "submit" as const },
      { name, meta: true, action: "submit" as const },
    ]),
    onContentChange: () => draw(),
  });
  const editorBox = new BoxRenderable(renderer, {
    border: true,
    title: "Message",
    height: editorRows,
    flexShrink: 0,
  });
  editorBox.add(editor);
  const footer = new TextRenderable(renderer, { content: "", flexShrink: 0 });
  const root = new BoxRenderable(renderer, {
    flexDirection: "column",
    width: "100%",
    height: "100%",
    padding: 1,
    gap: 1,
  });
  for (const child of [scroll, approval, listing, editorBox, footer]) {
    root.add(child);
  }
  renderer.root.add(root);
  editor.focus();

  // Settling work may outlive the view; destroyed renderables must not be touched.
  const draw = () => {
    if (renderer.isDestroyed) {
      return;
    }
    transcript.content = entries
      .map(({ input, lines }) => [`› ${printable(input)}`, ...lines].join("\n"))
      .join("\n\n");
    const status = interrupting
      ? "Interrupt requested; cleanup continuing"
      : phase === "running" && shown !== undefined
        ? "Awaiting approval"
        : {
            idle: "Ready",
            command: "Running a Command",
            parsing: "Parsing input",
            running: "Running",
            rendering: "Rendering result",
          }[phase];
    const footerLines = [
      `${status} • ${committed} committed messages`,
      application.current().conversation ?? "",
      notice,
      help(application.keys, phase, shown, approval.focused),
    ].filter((line) => line !== "");
    footer.content = footerLines.join("\n");
    // The list takes only the rows that the padding, the gaps between the views, the editor, the
    // footer and an Approval leave, so the input that narrows it stays on the screen.
    const columns = Math.max(1, renderer.width - 2);
    let room = renderer.height - 2 - 3 - editorRows - (approval.visible ? approvalRows + 1 : 0);
    for (const line of footerLines) {
      room -= Math.max(1, Math.ceil(line.length / columns));
    }
    const typed = /^\/(\S*)/.exec(editor.plainText)?.[1];
    const matching =
      typed === undefined
        ? []
        : application.current().commands.filter(({ name }) => name.startsWith(typed));
    const listed = matching.length <= room ? matching : matching.slice(0, Math.max(0, room - 1));
    const more = matching.length - listed.length;
    const width = Math.max(0, ...listed.map(({ name }) => name.length));
    listing.content = [
      ...listed.map(({ name, description }) => `/${name.padEnd(width)}  ${printable(description)}`),
      ...(more > 0 ? [`… and ${more} more Commands; type to narrow them`] : []),
    ].join("\n");
    listing.visible = room > 0 && matching.length > 0;
    renderer.requestRender();
  };

  const showApproval = (next: PendingApproval | undefined) => {
    if (next === shown || renderer.isDestroyed) {
      return;
    }
    shown = next;
    // Hiding the view blurs it, so whether it had focus is read first.
    const focused = approval.focused;
    approval.visible = next !== undefined;
    // Also when another request replaces it: `y` or `n` decides only a request the person focused.
    if (focused) {
      editor.focus();
    }
    if (next !== undefined) {
      approvalText.content = [
        `Turn ${printable(next.turnId)}`,
        `Tool call ${printable(next.toolCallId)}`,
        `Tool ${printable(next.name)}`,
        "Parameters:",
        showParams(next),
      ].join("\n");
    }
    draw();
  };

  const current = () => entries.at(-1);

  const decideWith = (key: KeyEvent) => {
    const decision: ApprovalDecision | undefined =
      key.ctrl || key.meta
        ? undefined
        : key.name === "y"
          ? "allow"
          : key.name === "n"
            ? "deny"
            : undefined;
    const request = shown;
    if (decision === undefined || request === undefined) {
      return;
    }
    key.preventDefault();
    runFork(
      Effect.flatMap(
        Effect.suspend(() => request.decide(decision)),
        (result) =>
          Effect.sync(() => {
            const call = `${printable(request.name)} (${printable(request.toolCallId)})`;
            const line =
              result === "stale"
                ? `Decision on ${call} was stale; nothing changed.`
                : decision === "allow"
                  ? `Approved ${call}.`
                  : `Denied ${call}; the program decides how the Turn continues.`;
            const entry = current();
            if (entry === undefined) {
              notice = line;
            } else {
              entry.lines.push(line);
            }
            if (shown === request) {
              showApproval(undefined);
            }
            draw();
          }),
      ),
    );
  };

  /** Runs one stage as its own fiber, so Escape interrupts that stage and settlement still runs. */
  const staged = Effect.fnUntraced(function* <X>(
    next: Phase,
    effect: () => Effect.Effect<X, unknown>,
  ) {
    phase = next;
    draw();
    // Suspended, so a mapping that throws instead of failing is still this stage's Exit.
    const fiber = yield* Effect.forkChild(Effect.suspend(effect));
    stage = fiber;
    return yield* Fiber.await(fiber).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          stage = undefined;
        }),
      ),
    );
  });

  /** Runs the Command a submission names; succeeds with the input it prompts, if any. */
  const runCommand = Effect.fnUntraced(function* (name: string, input: string, entry: Entry) {
    if (name === "new") {
      const before = application.current();
      const started = yield* staged("command", () => application.newConversation);
      // An interrupt can arrive after the switch, while the replaced Session closes.
      entry.lines.push(
        application.current() !== before
          ? "Started a new conversation."
          : Exit.isFailure(started) && !Cause.hasInterruptsOnly(started.cause)
            ? `Could not start a new conversation: ${reasons(started.cause)}`
            : "Interrupted; the conversation is unchanged.",
      );
      return undefined;
    }
    const ran = yield* staged("command", () => application.command(name, input));
    if (Exit.isFailure(ran)) {
      entry.lines.push(
        Cause.hasInterruptsOnly(ran.cause)
          ? `Command /${name} was interrupted.`
          : reasons(ran.cause),
      );
      return undefined;
    }
    return Match.valueTags(ran.value, {
      Reply: ({ text }) => {
        entry.lines.push(`/${name} replied (not sent to the Model):`, printable(text));
        return undefined;
      },
      Prompt: ({ text }) => text,
    });
  });

  const pipeline = Effect.fnUntraced(
    function* (text: string, entry: Entry) {
      const named = Command.parse(text);
      const input = named === undefined ? text : yield* runCommand(named.name, named.input, entry);
      if (input === undefined) {
        return;
      }
      const parsed = yield* staged("parsing", () => application.parseInput(input));
      if (Exit.isFailure(parsed)) {
        entry.lines.push(
          Cause.hasInterruptsOnly(parsed.cause)
            ? "Interrupted before a Turn started."
            : `Not run: the input could not be parsed: ${reasons(parsed.cause)}`,
        );
        return;
      }
      const before = (yield* Effect.exit(application.turns)).pipe(
        Exit.match({ onFailure: () => 0, onSuccess: (turns) => turns.length }),
      );
      const ran = yield* staged("running", () => application.run(parsed.value));
      const turns = yield* Effect.exit(application.turns);
      const snapshot =
        Exit.isSuccess(turns) && turns.value.length > before ? turns.value.at(-1) : undefined;
      if (snapshot === undefined) {
        entry.lines.push(
          Exit.isFailure(ran)
            ? `No Turn ran: ${reasons(ran.cause)}`
            : "The Turn's record is unavailable.",
        );
      } else {
        entry.lines.push(outcome(ran, snapshot));
      }
      if (Exit.isFailure(ran)) {
        return;
      }
      const rendered = yield* staged("rendering", () => application.renderResult(ran.value));
      if (Exit.isFailure(rendered)) {
        entry.lines.push(
          `The Turn succeeded, but its result could not be rendered (it is not rerun): ${reasons(rendered.cause)}`,
        );
      } else if (!Predicate.isString(rendered.value)) {
        entry.lines.push(
          "The Turn succeeded, but text.render did not produce a string; it is not rerun.",
        );
      } else {
        entry.lines.push(printable(rendered.value));
      }
    },
    Effect.ensuring(
      Effect.gen(function* () {
        const history = yield* Effect.exit(application.history);
        if (Exit.isSuccess(history)) {
          committed = history.value.length;
        }
        phase = "idle";
        interrupting = false;
        if (!renderer.isDestroyed && !approval.focused) {
          editor.focus();
        }
        draw();
      }),
    ),
  );

  /** Submits `text` unless another submission runs; says whether it was taken. */
  const submitText = (text: string) => {
    if (text === "") {
      return false;
    }
    if (phase !== "idle") {
      notice = "A submission is still running; your draft is kept.";
      draw();
      return false;
    }
    notice = "";
    if (Command.parse(text)?.name === "quit") {
      // Closes as Ctrl-C does.
      renderer.destroy();
      return true;
    }
    const entry: Entry = { input: text, lines: [] };
    entries.push(entry);
    phase = "parsing";
    runFork(pipeline(text, entry));
    return true;
  };

  const submit = () => {
    // `/quit` destroys the editor with the renderer.
    if (submitText(editor.plainText) && !renderer.isDestroyed) {
      editor.clear();
    }
  };

  const onKey = (key: KeyEvent) => {
    // Only a plain Tab; a Tab with a modifier may be bound.
    if (key.name === "tab" && !key.shift && !key.ctrl && !key.meta && shown !== undefined) {
      key.preventDefault();
      if (approval.focused) {
        editor.focus();
      } else {
        approval.focus();
      }
      return draw();
    }
    const binding = keysOf(key)
      .map((name) => application.keys.get(name))
      .find(Predicate.isNotUndefined);
    if (binding === undefined) {
      return;
    }
    key.preventDefault();
    // Text is typed into an empty input and sent; the person's draft stays as it is.
    if (Predicate.isString(binding)) {
      return void submitText(binding);
    }
    if (isControl(binding, terminal.submit)) {
      return submit();
    }
    if (isControl(binding, terminal.newline)) {
      if (editor.focused) {
        editor.newLine();
      }
      return;
    }
    if (isControl(binding, terminal.interrupt) && stage !== undefined && !interrupting) {
      interrupting = true;
      runFork(Fiber.interrupt(stage));
      draw();
    }
  };
  draw();

  const refresh = Effect.gen(function* () {
    const pending = yield* application.approvals.pending;
    showApproval(pending[0]);
  });
  // OpenTUI reports a failed frame through this event and otherwise keeps running.
  const renderFailed = Deferred.makeUnsafe<never, Cause.UnknownError>();
  const onRenderError = ({ error }: { readonly error: Error }) =>
    Deferred.doneUnsafe(
      renderFailed,
      Effect.fail(new Cause.UnknownError(error, `The terminal failed to render: ${error.message}`)),
    );
  yield* Effect.acquireUseRelease(
    Effect.sync(() => {
      renderer.keyInput.on("keypress", onKey);
      renderer.on("render:error", onRenderError);
      // The Command list is cut to the rows there are, which a resize changes.
      renderer.on("resize", draw);
      runFork(Effect.forever(Effect.andThen(refresh, Effect.sleep(refreshMillis))));
    }),
    // Ends on close, a failed frame or a defect in launched work without waiting for any of that
    // work, the poll included, so the caller can start its deadline before settling it.
    () =>
      Effect.raceFirst(
        // A rejected close here is no user close: the terminal's output failed with nothing else
        // having failed first.
        Effect.tryPromise({
          try: () => renderer.closed,
          catch: (error) => new Cause.UnknownError(error, "The terminal failed while closing"),
        }),
        Effect.raceFirst(Deferred.await(renderFailed), FiberSet.join(launched)),
      ),
    () =>
      Effect.sync(() => {
        renderer.keyInput.off("keypress", onKey);
        renderer.off("render:error", onRenderError);
        renderer.off("resize", draw);
      }),
  );
});
