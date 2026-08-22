import { describe, expect, test } from "bun:test";
import { tui } from "../src/index.js";

describe("TUI Host", () => {
  test("declares the interactive Host contract", () => {
    expect(tui()).toMatchObject({ name: "tui", mode: "interactive" });
  });

  test("loads its Solid preload before rendering", async () => {
    const entry = new URL("../src/index.ts", import.meta.url).href;
    const source = `
      const { tui } = await import(${JSON.stringify(entry)});
      setTimeout(() => process.kill(process.pid, "SIGINT"), 1_000);
      await tui().run({ agent: {}, prompt: "dynamic preload" });
      console.log("DYNAMIC_PRELOAD_OK");
    `;
    const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", source], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("DYNAMIC_PRELOAD_OK");
  });
});
