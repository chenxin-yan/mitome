import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { Shell } from "../src/shell.js";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(() => setup?.renderer.destroy());

describe("TUI shell", () => {
  test("stages the initial prompt and focuses its input", async () => {
    setup = await testRender(() => <Shell prompt="staged prompt" />, { width: 60, height: 12 });
    await setup.flush();

    expect(setup.captureCharFrame()).toContain("staged prompt");
    expect(setup.renderer.currentFocusedRenderable?.id).toBe("prompt");
  });
});
