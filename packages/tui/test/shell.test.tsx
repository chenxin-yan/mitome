import { afterEach, describe, expect, test } from "bun:test";
import type { TurnEvent } from "@mitome/core";
import { testRender } from "@opentui/solid";
import { Stream } from "effect";
import { Shell } from "../src/shell.js";
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
) => {
  let next = 0;
  viewModel = makeSessionViewModel({
    prompt: () => streams[next++] ?? Stream.empty,
    history: () => [],
  });
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
