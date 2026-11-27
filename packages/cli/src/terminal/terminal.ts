/** The terminal Host for one acquired Configuration and its one Session, on OpenTUI. */

import type { ApprovalDecision, Session } from "@mitome/core";
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

/**
 * What the terminal runs, already bound to one acquired Configuration: its explicit input and result
 * mappings, one retained Session, and the Approval channel whose Approver answers its Turns.
 */
export interface TerminalApplication<Input, A> {
  readonly parseInput: (text: string) => Effect.Effect<Input, unknown>;
  /** Runs one Turn of the retained Session, with the Approver whose requests `approvals` shows. */
  readonly run: (input: Input) => Effect.Effect<A, unknown>;
  /** Its success must be a string; it is shown as application output, never as a Message. */
  readonly renderResult: (result: A) => Effect.Effect<unknown, unknown>;
  readonly history: Effect.Effect<ReadonlyArray<Prompt.Message>, unknown>;
  readonly turns: Effect.Effect<ReadonlyArray<Session.TurnSnapshot>, unknown>;
  readonly approvals: ApprovalChannel;
  /** Names the kept conversation for a person, shown throughout; `undefined` when none is kept. */
  readonly conversation: string | undefined;
}

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
  if (Exit.isSuccess(exit)) return `Turn ${snapshot.id} succeeded; ${conversation}.`;
  return Cause.hasInterruptsOnly(exit.cause)
    ? `Turn ${snapshot.id} interrupted; ${conversation}.`
    : `Turn ${snapshot.id} failed: ${reasons(exit.cause)}; ${conversation}.`;
};

type Phase = "idle" | "parsing" | "running" | "rendering";

/** One submitted input and what happened to it, in order. */
interface Entry {
  readonly input: string;
  readonly lines: Array<string>;
}

const help = (phase: Phase, approval: PendingApproval | undefined, deciding: boolean) =>
  [
    approval === undefined ? undefined : deciding ? "y approve • n deny • Tab back" : "Tab decide",
    phase === "idle" ? "Alt-Enter send" : "Esc interrupt",
    "Ctrl-C close",
  ]
    .filter(Predicate.isNotUndefined)
    .join(" • ");

/**
 * Runs the terminal until it is closed (Ctrl-C, a signal, or the renderer's own destruction) or
 * fails (a failed frame, or a defect in launched work such as a decision), then restores it.
 * Submissions run one at a time as parse, one Turn, render; a stage's failure, thrown or returned,
 * is shown for that submission. All launched work, the Approval poll included, is forked into the
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
    height: 10,
    flexShrink: 0,
    visible: false,
    onKeyDown: (key) => decideWith(key),
  });
  approval.add(approvalText);
  const editor = new TextareaRenderable(renderer, {
    id: "message",
    flexGrow: 1,
    placeholder: "Type a message",
    onSubmit: () => submit(),
  });
  const editorBox = new BoxRenderable(renderer, {
    border: true,
    title: "Message",
    height: 5,
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
  for (const child of [scroll, approval, editorBox, footer]) root.add(child);
  renderer.root.add(root);
  editor.focus();

  // Settling work may outlive the view; destroyed renderables must not be touched.
  const draw = () => {
    if (renderer.isDestroyed) return;
    transcript.content = entries
      .map(({ input, lines }) => [`› ${printable(input)}`, ...lines].join("\n"))
      .join("\n\n");
    const status = interrupting
      ? "Interrupt requested; cleanup continuing"
      : phase === "running" && shown !== undefined
        ? "Awaiting approval"
        : {
            idle: "Ready",
            parsing: "Parsing input",
            running: "Running",
            rendering: "Rendering result",
          }[phase];
    footer.content = [
      `${status} • ${committed} committed messages`,
      application.conversation ?? "",
      notice,
      help(phase, shown, approval.focused),
    ]
      .filter((line) => line !== "")
      .join("\n");
    renderer.requestRender();
  };

  const showApproval = (next: PendingApproval | undefined) => {
    if (next === shown || renderer.isDestroyed) return;
    shown = next;
    // Hiding the view blurs it, so whether it had focus is read first.
    const focused = approval.focused;
    approval.visible = next !== undefined;
    // Also when another request replaces it: `y` or `n` decides only a request the person focused.
    if (focused) editor.focus();
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
    if (decision === undefined || request === undefined) return;
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
            if (entry === undefined) notice = line;
            else entry.lines.push(line);
            if (shown === request) showApproval(undefined);
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

  const pipeline = Effect.fnUntraced(
    function* (text: string, entry: Entry) {
      const parsed = yield* staged("parsing", () => application.parseInput(text));
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
      if (Exit.isFailure(ran)) return;
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
        if (Exit.isSuccess(history)) committed = history.value.length;
        phase = "idle";
        interrupting = false;
        if (!renderer.isDestroyed && !approval.focused) editor.focus();
        draw();
      }),
    ),
  );

  const submit = () => {
    const text = editor.plainText;
    if (text === "") return;
    if (phase !== "idle") {
      notice = "A submission is still running; your draft is kept.";
      return draw();
    }
    notice = "";
    const entry: Entry = { input: text, lines: [] };
    entries.push(entry);
    editor.clear();
    phase = "parsing";
    runFork(pipeline(text, entry));
  };

  const onKey = (key: KeyEvent) => {
    if (key.name === "tab" && shown !== undefined) {
      key.preventDefault();
      if (approval.focused) editor.focus();
      else approval.focus();
      return draw();
    }
    if (key.name === "escape" && stage !== undefined && !interrupting) {
      key.preventDefault();
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
      }),
  );
});
