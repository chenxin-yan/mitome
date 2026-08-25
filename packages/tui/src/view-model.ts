import type { TranscriptSummary, TurnEvent } from "@mitome/core";
import { Cause, Effect, Exit, Fiber, Stream } from "effect";
import type { SessionManager, SessionResource } from "./session-manager.js";

export interface SessionTurn {
  readonly prompt: string;
  readonly response: string;
  readonly activities: ReadonlyArray<string>;
}

export interface TranscriptPickerState {
  readonly loading: boolean;
  readonly summaries: ReadonlyArray<TranscriptSummary>;
  readonly selected: number;
}

export interface SessionState {
  readonly phase: "idle" | "running" | "interrupting" | "switching";
  readonly turns: ReadonlyArray<SessionTurn>;
  readonly activeTurn?: SessionTurn | undefined;
  readonly picker?: TranscriptPickerState | undefined;
  readonly notice?: string | undefined;
}

export interface SessionViewModel {
  readonly getState: () => SessionState;
  readonly subscribe: (listener: (state: SessionState) => void) => () => void;
  readonly submit: (text: string) => boolean;
  readonly interrupt: () => boolean;
  readonly openTranscriptPicker: () => boolean;
  readonly closeTranscriptPicker: () => boolean;
  readonly moveTranscriptSelection: (offset: number) => boolean;
  readonly resumeTranscript: () => boolean;
  readonly newSession: () => boolean;
  readonly dispose: () => Promise<void>;
}

interface ActiveRun {
  readonly fiber: Fiber.Fiber<void, unknown>;
  readonly historyLength: number;
  readonly completed: () => boolean;
  interrupted: boolean;
}

// Cleanup bound: a stuck Session close or open must not wedge the TUI in the
// switching phase or keep the process from exiting. Resolves undefined on
// timeout; the underlying work keeps running and its late rejection is marked
// handled so it cannot surface as an unhandled rejection.
// ponytail: fixed 1s bound, make it configurable if real cleanup needs longer.
const bounded = <T>(work: Promise<T>): Promise<T | undefined> => {
  let cancel!: () => void;
  void work.catch(() => undefined);
  return Promise.race([
    work,
    new Promise<undefined>((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      cancel = () => clearTimeout(timer);
    }),
  ]).finally(() => cancel());
};

const activity = (event: TurnEvent): string | undefined => {
  switch (event.type) {
    case "tool-call":
      return `Tool ${event.name} started`;
    case "approval-required":
      return `Tool ${event.name} auto-approved`;
    case "tool-result":
      return `Tool ${event.name} ${event.isFailure ? "failed" : "completed"}`;
    case "model-output":
    case "reasoning":
    case "response-complete":
      return undefined;
    default:
      event satisfies never;
      return undefined;
  }
};

export const makeSessionViewModel = (
  initialSession: SessionResource,
  manager?: SessionManager,
): SessionViewModel => {
  let session = initialSession;
  let state: SessionState = { phase: "idle", turns: [] };
  let active: ActiveRun | undefined;
  let switching: Promise<void> | undefined;
  let pickerRequest = 0;
  let disposed = false;
  // Reads `disposed` after an await; the wrapper stops TS/oxlint from stale
  // control-flow narrowing ("always falsy") across the async boundary.
  const isDisposed = (): boolean => disposed;
  const listeners = new Set<(state: SessionState) => void>();

  const publish = (next: SessionState): void => {
    state = next;
    for (const listener of listeners) listener(state);
  };

  const handleEvent = (event: TurnEvent, complete: () => void): Effect.Effect<void, unknown> => {
    const current = state.activeTurn;
    if (current === undefined) return Effect.void;
    if (event.type === "model-output") {
      publish({
        ...state,
        activeTurn: { ...current, response: current.response + event.text },
      });
    } else {
      const nextActivity = activity(event);
      if (nextActivity !== undefined) {
        publish({
          ...state,
          activeTurn: {
            ...current,
            activities: [...current.activities, nextActivity],
          },
        });
      }
    }
    if (event.type === "response-complete") complete();
    return event.type === "approval-required" ? event.approve() : Effect.void;
  };

  const submit = (text: string): boolean => {
    if (disposed || state.phase !== "idle" || state.picker !== undefined || text.trim() === "") {
      return false;
    }
    publish({
      ...state,
      phase: "running",
      activeTurn: { prompt: text, response: "", activities: [] },
      notice: undefined,
    });
    let completed = false;
    const historyLength = session.history().length;
    const fiber = Effect.runFork(
      Stream.runForEach(session.prompt(text), (event) =>
        handleEvent(event, () => {
          completed = true;
        }),
      ),
    );
    const run: ActiveRun = {
      fiber,
      historyLength,
      completed: () => completed,
      interrupted: false,
    };
    active = run;
    void Effect.runPromise(Fiber.await(fiber)).then((exit) => {
      if (disposed || active !== run) return;
      active = undefined;
      const turn = state.activeTurn;
      const interrupted =
        run.interrupted || (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
      const committed = session.history().length > run.historyLength;
      if (
        turn !== undefined &&
        (committed || (!interrupted && Exit.isSuccess(exit) && completed))
      ) {
        publish({
          phase: "idle",
          turns: [...state.turns, turn],
          // The turn is committed to history before the Transcript save runs
          // and response-complete is only emitted after the save succeeds. An
          // interrupt before completion may therefore have cut the save short;
          // only a late interrupt after completion is safe to silence.
          notice:
            !completed && interrupted
              ? "Turn interrupted; the Transcript may not have saved."
              : Exit.isFailure(exit) && !interrupted
                ? Cause.pretty(exit.cause)
                : undefined,
        });
        return;
      }
      publish({
        phase: "idle",
        turns: state.turns,
        notice: interrupted
          ? "Turn interrupted."
          : Exit.isFailure(exit)
            ? Cause.pretty(exit.cause)
            : "Turn ended before completing.",
      });
    });
    return true;
  };

  const interrupt = (): boolean => {
    if (active === undefined || state.phase !== "running" || active.completed()) return false;
    active.interrupted = true;
    publish({ ...state, phase: "interrupting" });
    Effect.runFork(Fiber.interrupt(active.fiber));
    return true;
  };

  const openTranscriptPicker = (): boolean => {
    if (disposed || state.phase !== "idle" || state.picker !== undefined) return false;
    if (manager?.transcripts === undefined) {
      publish({ ...state, notice: "Transcript persistence is not configured." });
      return true;
    }
    const request = ++pickerRequest;
    publish({
      ...state,
      picker: { loading: true, summaries: [], selected: 0 },
      notice: undefined,
    });
    void Effect.runPromiseExit(manager.transcripts.list()).then((exit) => {
      if (disposed || request !== pickerRequest) return;
      if (Exit.isFailure(exit)) {
        publish({
          ...state,
          picker: undefined,
          notice: `Could not list Transcripts: ${Cause.pretty(exit.cause)}`,
        });
        return;
      }
      publish({
        ...state,
        picker: {
          loading: false,
          summaries: [...exit.value].sort((left, right) =>
            left.updatedAt < right.updatedAt ? 1 : left.updatedAt > right.updatedAt ? -1 : 0,
          ),
          selected: 0,
        },
      });
    });
    return true;
  };

  const closeTranscriptPicker = (): boolean => {
    if (state.picker === undefined || state.phase !== "idle") return false;
    pickerRequest += 1;
    publish({ ...state, picker: undefined });
    return true;
  };

  const moveTranscriptSelection = (offset: number): boolean => {
    const picker = state.picker;
    if (picker === undefined || picker.loading || picker.summaries.length === 0) return false;
    const selected = Math.max(0, Math.min(picker.summaries.length - 1, picker.selected + offset));
    publish({ ...state, picker: { ...picker, selected } });
    return true;
  };

  const replaceSession = (transcriptId: string | undefined, notice: string): boolean => {
    if (disposed || manager === undefined || state.phase !== "idle") return false;
    pickerRequest += 1;
    publish({ ...state, phase: "switching", picker: undefined });
    const previous = session;
    const operation = (async () => {
      const opened = await Effect.runPromiseExit(manager.open(transcriptId));
      if (Exit.isFailure(opened)) {
        publish({
          ...state,
          phase: "idle",
          notice: `Could not start Session: ${Cause.pretty(opened.cause)}`,
        });
        return;
      }
      const next = opened.value;
      if (isDisposed()) {
        await Effect.runPromiseExit(next.close);
        return;
      }
      session = next;
      const closed = await bounded(Effect.runPromiseExit(previous.close));
      publish({
        phase: "idle",
        turns: [],
        notice:
          closed === undefined
            ? "Previous Session did not close in time."
            : Exit.isFailure(closed)
              ? `Could not close previous Session: ${Cause.pretty(closed.cause)}`
              : notice,
      });
    })();
    switching = operation;
    return true;
  };

  const resumeTranscript = (): boolean => {
    const picker = state.picker;
    const summary = picker?.summaries[picker.selected];
    if (picker === undefined || picker.loading || summary === undefined) return false;
    return replaceSession(summary.id, "Transcript resumed in a new Session.");
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    submit,
    interrupt,
    openTranscriptPicker,
    closeTranscriptPicker,
    moveTranscriptSelection,
    resumeTranscript,
    newSession: () => replaceSession(undefined, "Started a new Session."),
    dispose: async () => {
      disposed = true;
      const running = active;
      active = undefined;
      listeners.clear();
      if (running !== undefined) {
        await bounded(Effect.runPromise(Fiber.interrupt(running.fiber)));
      }
      if (switching !== undefined) await bounded(switching);
      await bounded(Effect.runPromise(session.close));
    },
  };
};
