import { describe, expect, it } from "bun:test";
import { testRender } from "@opentui/solid";
import { Spike, type SpikeResult } from "../src/index.js";

const result = (): SpikeResult => ({
  input: "",
  focusMoves: 0,
  streamCompleted: false,
  scrollMoves: 0,
});

describe("OpenTUI Solid spike", () => {
  it("handles multiline paste, streaming, scrolling, focus movement, and exit", async () => {
    const state = result();
    const setup = await testRender(() => <Spike prompt="test prompt" result={state} />, {
      width: 80,
      height: 24,
    });

    await setup.flush();
    await setup.mockInput.pasteBracketedText("line one\nline two");
    setup.mockInput.pressTab();
    await Bun.sleep(200);
    await setup.flush();

    expect(state.streamCompleted).toBe(true);
    expect(state.focusMoves).toBe(1);
    expect(setup.renderer.currentFocusedRenderable?.id).toBe("output");
    expect(setup.captureCharFrame()).toContain("Streamed model output arrives incrementally.");

    setup.mockInput.pressArrow("down");
    expect(state.scrollMoves).toBe(1);
    expect(setup.renderer.currentFocusedRenderable?.id).toBe("output");

    setup.mockInput.pressKey("q");
    expect(state).toEqual({
      input: "line one\nline two",
      focusMoves: 1,
      streamCompleted: true,
      scrollMoves: 1,
    });
  });
});
