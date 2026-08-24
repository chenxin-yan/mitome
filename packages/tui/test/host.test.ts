import { describe, expect, test } from "bun:test";
import { tui } from "../src/index.js";

describe("TUI Host", () => {
  test("declares the interactive Host contract", () => {
    expect(tui()).toMatchObject({ name: "tui", mode: "interactive" });
  });

  test("requires an interactive terminal", () => {
    const originalIn = process.stdin.isTTY;
    const originalOut = process.stdout.isTTY;
    try {
      process.stdin.isTTY = true;
      process.stdout.isTTY = true;
      expect(tui().unsupported?.()).toBeUndefined();
      process.stdout.isTTY = false;
      expect(tui().unsupported?.()).toBe("@mitome/tui requires an interactive terminal");
    } finally {
      process.stdin.isTTY = originalIn;
      process.stdout.isTTY = originalOut;
    }
  });

  test("loads its Solid preload before rendering", async () => {
    const entry = new URL("../src/index.ts", import.meta.url).href;
    const source = `
      const { tui } = await import(${JSON.stringify(entry)});
      await tui().run({ agent: {}, prompt: "dynamic preload" });
      console.log("DYNAMIC_PRELOAD_OK");
    `;
    const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", source], {
      stdout: "pipe",
      stderr: "pipe",
    });

    let interrupt: ReturnType<typeof setTimeout> | undefined;
    const hardKill = setTimeout(() => child.kill("SIGKILL"), 20_000);
    const exited = child.exited.finally(() => {
      clearTimeout(hardKill);
      if (interrupt !== undefined) clearTimeout(interrupt);
    });
    let stdout = "";
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      stdout += decoder.decode(chunk, { stream: true });
      // First output proves renderer startup; repeating SIGINT can race terminal teardown.
      interrupt ??= setTimeout(() => child.kill("SIGINT"), 500);
    }
    const [exitCode, stderr] = await Promise.all([exited, new Response(child.stderr).text()]);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("DYNAMIC_PRELOAD_OK");
  }, 30_000);
});
