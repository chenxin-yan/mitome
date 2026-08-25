import { describe, expect, test } from "bun:test";
import { createSession, makeProvider, memoryTranscripts, StoreError } from "@mitome/core";
import type { TranscriptStore, TurnEvent } from "@mitome/core";
import { Effect, Layer, Stream } from "effect";
import { LanguageModel, Response } from "effect/unstable/ai";
import { makeSessionManager } from "../src/session-manager.js";
import type { SessionResource } from "../src/session-manager.js";
import { makeSessionViewModel } from "../src/view-model.js";
import type { SessionState } from "../src/view-model.js";

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for session state");
};

const scriptedSession = (
  scripts: ReadonlyArray<Stream.Stream<TurnEvent, never>>,
): SessionResource => {
  let next = 0;
  return {
    prompt: () => scripts[next++] ?? Stream.empty,
    history: () => [],
    close: Effect.void,
  };
};

describe("session view model", () => {
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
    const viewModel = makeSessionViewModel(session);
    const observed: Array<SessionState> = [];
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

  test("rejects interruption after completion and commits the Turn", async () => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const events: [TurnEvent, TurnEvent] = [
      { type: "model-output", text: "done" },
      { type: "response-complete" },
    ];
    const session = scriptedSession([
      Stream.concat(
        Stream.fromIterable(events),
        Stream.fromEffectDrain(Effect.promise(() => finished)),
      ),
    ]);
    const viewModel = makeSessionViewModel(session);

    expect(viewModel.submit("cancel me")).toBe(true);
    await waitFor(() => viewModel.getState().activeTurn?.response === "done");
    expect(viewModel.interrupt()).toBe(false);
    finish();
    await waitFor(() => viewModel.getState().phase === "idle");

    expect(viewModel.getState().turns).toEqual([
      { prompt: "cancel me", response: "done", activities: [] },
    ]);
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
    const viewModel = makeSessionViewModel(session);

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

  test("keeps a committed Turn visible when transcript persistence fails", async () => {
    const unsupported = () => Effect.die("not used");
    const provider = makeProvider("test", [] as const, undefined, () =>
      Layer.succeed(LanguageModel.LanguageModel, {
        generateText: unsupported,
        generateObject: unsupported,
        streamText: () =>
          Stream.succeed(Response.makePart("text-delta", { id: "saved", delta: "kept" })),
      }),
    );
    const store: TranscriptStore = {
      save: () => Effect.fail(new StoreError({ message: "save failed" })),
      appendEvent: () => Effect.void,
      load: () => Effect.die("not used"),
      list: () => Effect.die("not used"),
    };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* createSession(
            { providers: [provider], model: "test/default", extensions: [] },
            { transcripts: store },
          );
          const viewModel = makeSessionViewModel({ ...session, close: Effect.void });
          yield* Effect.promise(async () => {
            viewModel.submit("persist me");
            await waitFor(() => viewModel.getState().phase === "idle");

            expect(session.history()).toHaveLength(1);
            expect(viewModel.getState().turns).toEqual([
              { prompt: "persist me", response: "kept", activities: [] },
            ]);
            expect(viewModel.getState().notice).toContain("save failed");
            await viewModel.dispose();
          });
        }),
      ),
    );
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
          const viewModel = makeSessionViewModel({ ...session, close: Effect.void });
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

  test("lists, resumes, and starts new Sessions without changing prior Transcripts", async () => {
    const seenPrompts: Array<string> = [];
    const unsupported = () => Effect.die("not used");
    const provider = makeProvider("test", [] as const, undefined, () =>
      Layer.succeed(LanguageModel.LanguageModel, {
        generateText: unsupported,
        generateObject: unsupported,
        streamText: (options: { readonly prompt: unknown }) => {
          seenPrompts.push(JSON.stringify(options.prompt));
          return Stream.succeed(
            Response.makePart("text-delta", {
              id: String(seenPrompts.length),
              delta: `answer ${seenPrompts.length}`,
            }),
          );
        },
      }),
    );
    const transcripts = memoryTranscripts();
    const manager = makeSessionManager({
      agent: { providers: [provider], model: "test/default", extensions: [] },
      prompt: "",
      transcripts,
    });
    const initial = await Effect.runPromise(manager.open());
    const viewModel = makeSessionViewModel(initial, manager);

    viewModel.submit("first topic");
    await waitFor(() => viewModel.getState().phase === "idle");
    const [firstSummary] = await Effect.runPromise(transcripts.list());
    expect(firstSummary?.preview).toBe("first topic");

    expect(viewModel.newSession()).toBe(true);
    await waitFor(() => viewModel.getState().notice === "Started a new Session.");
    expect(viewModel.getState().turns).toEqual([]);
    expect((await Effect.runPromise(transcripts.list())).map(({ id }) => id)).toContain(
      firstSummary!.id,
    );

    viewModel.submit("second topic");
    await waitFor(() => viewModel.getState().phase === "idle");
    expect(await Effect.runPromise(transcripts.list())).toHaveLength(2);

    expect(viewModel.openTranscriptPicker()).toBe(true);
    await waitFor(() => viewModel.getState().picker?.loading === false);
    const picker = viewModel.getState().picker!;
    expect(picker.summaries.map(({ preview }) => preview)).toContain("first topic");
    const firstIndex = picker.summaries.findIndex(({ id }) => id === firstSummary!.id);
    viewModel.moveTranscriptSelection(firstIndex);
    expect(viewModel.resumeTranscript()).toBe(true);
    await waitFor(() => viewModel.getState().notice === "Transcript resumed in a new Session.");

    viewModel.submit("continued topic");
    await waitFor(() => viewModel.getState().phase === "idle");
    expect(seenPrompts[2]).toContain("first topic");
    expect(seenPrompts[2]).not.toContain("second topic");
    await viewModel.dispose();
    const persisted = await Effect.runPromise(transcripts.list());
    expect(
      persisted.some(({ parentTranscriptId }) => parentTranscriptId === firstSummary!.id),
    ).toBe(true);
  });

  test("remains usable when closing the previous Session defects", async () => {
    let nextCloses = 0;
    const initial = {
      ...scriptedSession([]),
      close: Effect.die(new Error("release failed")),
    };
    const next = {
      ...scriptedSession([
        Stream.make({ type: "model-output", text: "ready" }, { type: "response-complete" }),
      ]),
      close: Effect.sync(() => {
        nextCloses += 1;
      }),
    };
    const viewModel = makeSessionViewModel(initial, {
      transcripts: undefined,
      open: () => Effect.succeed(next),
    });

    expect(viewModel.newSession()).toBe(true);
    await waitFor(() => viewModel.getState().phase === "idle");
    expect(viewModel.getState().notice).toContain("Could not close previous Session");
    expect(viewModel.submit("still usable")).toBe(true);
    await waitFor(() => viewModel.getState().phase === "idle");
    expect(viewModel.getState().turns[0]?.response).toBe("ready");

    await viewModel.dispose();
    expect(nextCloses).toBe(1);
  });

  test("does not touch Transcript storage when none is configured", async () => {
    const session = scriptedSession([]);
    const viewModel = makeSessionViewModel(session, {
      transcripts: undefined,
      open: () => Effect.die("not used"),
    });

    expect(viewModel.openTranscriptPicker()).toBe(true);
    expect(viewModel.getState().picker).toBeUndefined();
    expect(viewModel.getState().notice).toBe("Transcript persistence is not configured.");
    await viewModel.dispose();
  });

  test("bounds disposal of an uninterruptible Turn", async () => {
    const session = scriptedSession([Stream.fromEffect(Effect.uninterruptible(Effect.never))]);
    const viewModel = makeSessionViewModel(session);

    viewModel.submit("stuck");
    const started = performance.now();
    await viewModel.dispose();

    expect(performance.now() - started).toBeLessThan(1_500);
  }, 2_000);
});
