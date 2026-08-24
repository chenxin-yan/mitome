import type { TurnEvent } from "@mitome/core";
import { Cause, Effect, Exit, Fiber, Stream } from "effect";

export interface ConversationTurn {
  readonly prompt: string;
  readonly response: string;
  readonly activities: ReadonlyArray<string>;
}

export interface ConversationState {
  readonly phase: "idle" | "running" | "interrupting";
  readonly turns: ReadonlyArray<ConversationTurn>;
  readonly activeTurn?: ConversationTurn | undefined;
  readonly notice?: string | undefined;
}

export interface ConversationSession {
  readonly prompt: (text: string) => Stream.Stream<TurnEvent, unknown>;
}

export interface ConversationViewModel {
  readonly getState: () => ConversationState;
  readonly subscribe: (listener: (state: ConversationState) => void) => () => void;
  readonly submit: (text: string) => boolean;
  readonly interrupt: () => boolean;
  readonly dispose: () => Promise<void>;
}

interface ActiveRun {
  readonly fiber: Fiber.Fiber<void, unknown>;
  interrupted: boolean;
}

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
  }
};

export const makeConversationViewModel = (session: ConversationSession): ConversationViewModel => {
  let state: ConversationState = { phase: "idle", turns: [] };
  let active: ActiveRun | undefined;
  let disposed = false;
  const listeners = new Set<(state: ConversationState) => void>();

  const publish = (next: ConversationState): void => {
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
    if (disposed || state.phase !== "idle" || text.trim() === "") return false;
    publish({
      ...state,
      phase: "running",
      activeTurn: { prompt: text, response: "", activities: [] },
      notice: undefined,
    });
    let completed = false;
    const fiber = Effect.runFork(
      Stream.runForEach(session.prompt(text), (event) =>
        handleEvent(event, () => {
          completed = true;
        }),
      ),
    );
    const run: ActiveRun = { fiber, interrupted: false };
    active = run;
    void Effect.runPromise(Fiber.await(fiber)).then((exit) => {
      if (disposed || active !== run) return;
      active = undefined;
      const turn = state.activeTurn;
      if (Exit.isSuccess(exit) && completed && turn !== undefined) {
        publish({ phase: "idle", turns: [...state.turns, turn] });
        return;
      }
      const interrupted =
        run.interrupted || (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
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
    if (active === undefined || state.phase !== "running") return false;
    active.interrupted = true;
    publish({ ...state, phase: "interrupting" });
    Effect.runFork(Fiber.interrupt(active.fiber));
    return true;
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
    dispose: async () => {
      disposed = true;
      const running = active;
      active = undefined;
      listeners.clear();
      if (running !== undefined) await Effect.runPromise(Fiber.interrupt(running.fiber));
    },
  };
};
