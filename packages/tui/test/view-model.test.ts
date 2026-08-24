import { describe, expect, test } from "bun:test";
import { createSession, makeProvider } from "@mitome/core";
import type { TurnEvent } from "@mitome/core";
import { Effect, Layer, Stream } from "effect";
import { LanguageModel, Response } from "effect/unstable/ai";
import { makeConversationViewModel } from "../src/view-model.js";
import type { ConversationSession, ConversationState } from "../src/view-model.js";

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for conversation state");
};

const scriptedSession = (
  scripts: ReadonlyArray<Stream.Stream<TurnEvent, never>>,
): ConversationSession => {
  let next = 0;
  return {
    prompt: () => scripts[next++] ?? Stream.empty,
  };
};

describe("conversation view model", () => {
  test("streams output, shows tool activity, auto-approves, and supports multiple Turns", async () => {
    let approvals = 0;
    const approval: TurnEvent = {
      type: "approval-required",
      approvalId: "approval-1",
      toolCallId: "call-1",
      name: "lookup",
      params: { query: "weather" },
      approve: () => Effect.sync(() => void approvals++),
      deny: () => Effect.void,
    };
    const session = scriptedSession([
      Stream.make(
        { type: "model-output", text: "hel" },
        { type: "model-output", text: "lo" },
        { type: "tool-call", id: "call-1", name: "lookup", params: {} },
        approval,
        {
          type: "tool-result",
          id: "call-1",
          name: "lookup",
          result: "sunny",
          isFailure: false,
        },
        { type: "response-complete" },
      ),
      Stream.make({ type: "model-output", text: "again" }, { type: "response-complete" }),
    ]);
    const viewModel = makeConversationViewModel(session);
    const observed: Array<ConversationState> = [];
    viewModel.subscribe((state) => observed.push(state));

    expect(viewModel.submit("first\nline")).toBe(true);
    await waitFor(() => viewModel.getState().phase === "idle");

    expect(observed.some((state) => state.activeTurn?.response === "hel")).toBe(true);
    expect(viewModel.getState().turns[0]).toEqual({
      prompt: "first\nline",
      response: "hello",
      activities: ["Tool lookup started", "Tool lookup auto-approved", "Tool lookup completed"],
    });
    expect(approvals).toBe(1);

    expect(viewModel.submit("second")).toBe(true);
    await waitFor(() => viewModel.getState().phase === "idle");
    expect(viewModel.getState().turns.map((turn) => turn.response)).toEqual(["hello", "again"]);
    await viewModel.dispose();
  });

  test("interrupts without retaining the active Turn and remains usable", async () => {
    const session = scriptedSession([
      Stream.concat(
        Stream.succeed<TurnEvent>({ type: "model-output", text: "partial" }),
        Stream.never,
      ),
      Stream.make({ type: "model-output", text: "recovered" }, { type: "response-complete" }),
    ]);
    const viewModel = makeConversationViewModel(session);

    expect(viewModel.submit("cancel me")).toBe(true);
    await waitFor(() => viewModel.getState().activeTurn?.response === "partial");
    expect(viewModel.interrupt()).toBe(true);
    await waitFor(() => viewModel.getState().phase === "idle");

    expect(viewModel.getState()).toMatchObject({
      turns: [],
      notice: "Turn interrupted.",
    });
    expect(viewModel.getState().activeTurn).toBeUndefined();
    expect(viewModel.submit("next")).toBe(true);
    await waitFor(() => viewModel.getState().phase === "idle");
    expect(viewModel.getState().turns).toEqual([
      { prompt: "next", response: "recovered", activities: [] },
    ]);
    await viewModel.dispose();
  });

  test("drives a real Session across interruption and later Turns", async () => {
    let calls = 0;
    const unsupported = () => Effect.die("not used");
    const provider = makeProvider("test", [] as const, undefined, () =>
      Layer.succeed(LanguageModel.LanguageModel, {
        generateText: unsupported,
        generateObject: unsupported,
        streamText: () => {
          calls += 1;
          const output = calls === 1 ? "partial" : calls === 2 ? "recovered" : "again";
          const part = Stream.succeed(
            Response.makePart("text-delta", { id: String(calls), delta: output }),
          );
          return calls === 1 ? Stream.concat(part, Stream.never) : part;
        },
      }),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* createSession({
            providers: [provider],
            model: "test/default",
            extensions: [],
          });
          const viewModel = makeConversationViewModel(session);
          yield* Effect.promise(async () => {
            viewModel.submit("discarded");
            await waitFor(() => viewModel.getState().activeTurn?.response === "partial");
            viewModel.interrupt();
            await waitFor(() => viewModel.getState().phase === "idle");
            expect(session.history()).toEqual([]);

            viewModel.submit("kept");
            await waitFor(() => viewModel.getState().phase === "idle");
            viewModel.submit("continued");
            await waitFor(() => viewModel.getState().phase === "idle");
            expect(viewModel.getState().turns.map((turn) => turn.response)).toEqual([
              "recovered",
              "again",
            ]);
            expect(session.history().map((message) => message.role)).toEqual(["user", "user"]);
            await viewModel.dispose();
          });
        }),
      ),
    );
  });
});
