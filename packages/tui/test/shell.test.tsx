import { afterEach, describe, expect, test } from "bun:test";
import type { TranscriptStore, TurnEvent } from "@mitome/core";
import { testRender } from "@opentui/solid";
import { Effect, Stream } from "effect";
import { Shell } from "../src/shell.js";
import type { SessionManager } from "../src/session-manager.js";
import { makeSessionViewModel } from "../src/view-model.js";
import type { SessionViewModel } from "../src/view-model.js";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
let viewModel: SessionViewModel | undefined;

afterEach(async () => {
  setup?.renderer.destroy();
  if (viewModel !== undefined) await viewModel.dispose();
});

const renderShell = async (
  prompt: string,
  streams: ReadonlyArray<Stream.Stream<TurnEvent, never>> = [],
  manager: SessionManager = { transcripts: undefined, open: () => Effect.die("not used") },
) => {
  let next = 0;
  viewModel = makeSessionViewModel(
    {
      prompt: () => streams[next++] ?? Stream.empty,
      history: () => [],
      close: Effect.void,
    },
    manager,
  );
  setup = await testRender(() => <Shell prompt={prompt} viewModel={viewModel!} />, {
    width: 70,
    height: 16,
  });
  await setup.flush();
};

describe("TUI shell", () => {
  test("stages the initial prompt and focuses its input", async () => {
    await renderShell("staged prompt");

    expect(setup!.captureCharFrame()).toContain("staged prompt");
    expect(setup!.renderer.currentFocusedRenderable?.id).toBe("prompt");
  });

  test("accepts multiline paste and renders a completed Turn", async () => {
    await renderShell("", [
      Stream.make(
        { type: "model-output", text: "streamed " },
        { type: "model-output", text: "answer" },
        { type: "response-complete" },
      ),
    ]);

    await setup!.mockInput.pasteBracketedText("first\nsecond");
    setup!.mockInput.pressEnter({ meta: true });
    const frame = await setup!.waitForFrame((candidate) => candidate.includes("streamed answer"));

    expect(frame).toContain("first");
    expect(frame).toContain("second");
    expect(frame).toContain("streamed answer");
    expect(setup!.renderer.currentFocusedRenderable?.id).toBe("prompt");
  });

  test("opens the Transcript picker from the keyboard", async () => {
    const unused = () => Effect.die("not used");
    const transcripts: TranscriptStore = {
      list: () =>
        Effect.succeed([
          {
            id: "saved",
            createdAt: "2026-08-25T01:00:00.000Z",
            updatedAt: "2026-08-25T02:00:00.000Z",
            messageCount: 2,
            preview: "saved topic",
          },
        ]),
      load: unused,
      save: unused,
      appendEvent: unused,
    };
    await renderShell("", [], {
      transcripts,
      open: () => Effect.die("not used"),
    });

    setup!.mockInput.pressKey("o", { ctrl: true });
    const frame = await setup!.waitForFrame((candidate) => candidate.includes("saved topic"));

    expect(frame).toContain("Transcripts");
    expect(frame).toContain("Enter resume");
    expect(frame).toContain("2026");
  });

  test("navigates the picker and resumes the selected Transcript", async () => {
    const unused = () => Effect.die("not used");
    const opened: Array<string | undefined> = [];
    const transcripts: TranscriptStore = {
      list: () =>
        Effect.succeed([
          {
            id: "newest",
            createdAt: "2026-08-25T01:00:00.000Z",
            updatedAt: "2026-08-25T02:00:00.000Z",
            messageCount: 2,
            preview: "newest topic",
          },
          {
            id: "older",
            createdAt: "2026-08-24T01:00:00.000Z",
            updatedAt: "2026-08-24T02:00:00.000Z",
            messageCount: 2,
            preview: "older topic",
          },
        ]),
      load: unused,
      save: unused,
      appendEvent: unused,
    };
    await renderShell("", [], {
      transcripts,
      open: (transcriptId) => {
        opened.push(transcriptId);
        return Effect.succeed({
          prompt: () => Stream.empty,
          history: () => [],
          close: Effect.void,
        });
      },
    });

    setup!.mockInput.pressKey("o", { ctrl: true });
    await setup!.waitForFrame((candidate) => candidate.includes("older topic"));
    setup!.mockInput.pressArrow("down");
    setup!.mockInput.pressEnter();
    await setup!.waitForFrame((candidate) =>
      candidate.includes("Transcript resumed in a new Session."),
    );

    expect(opened).toEqual(["older"]);
  });

  test("closes the picker with Escape", async () => {
    const unused = () => Effect.die("not used");
    const transcripts: TranscriptStore = {
      list: () => Effect.succeed([]),
      load: unused,
      save: unused,
      appendEvent: unused,
    };
    await renderShell("", [], { transcripts, open: unused });

    setup!.mockInput.pressKey("o", { ctrl: true });
    await setup!.waitForFrame((candidate) => candidate.includes("No Transcripts yet."));
    setup!.mockInput.pressEscape();
    // ESC needs the parser's escape-disambiguation window before it is flushed.
    await Bun.sleep(50);
    const frame = await setup!.waitForFrame((candidate) => candidate.includes("Ctrl-O list"));

    expect(frame).not.toContain("No Transcripts yet.");
  });

  test("starts a new Session with Ctrl-N", async () => {
    await renderShell("", [], {
      transcripts: undefined,
      open: () =>
        Effect.succeed({
          prompt: () => Stream.empty,
          history: () => [],
          close: Effect.void,
        }),
    });

    setup!.mockInput.pressKey("n", { ctrl: true });
    const frame = await setup!.waitForFrame((candidate) =>
      candidate.includes("Started a new Session."),
    );

    expect(frame).toContain("Type a prompt");
  });

  test("maps Escape to Turn interruption and restores the prompt", async () => {
    await renderShell("cancel", [Stream.never]);

    setup!.mockInput.pressEnter({ meta: true });
    await setup!.waitForFrame((frame) => frame.includes("Turn running"));
    setup!.mockInput.pressEscape();
    await Bun.sleep(50);
    const frame = await setup!.waitForFrame((candidate) => candidate.includes("Turn interrupted."));

    expect(frame).toContain("Type a prompt");
    expect(setup!.renderer.currentFocusedRenderable?.id).toBe("prompt");
  });
});
