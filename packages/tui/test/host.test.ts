import { describe, expect, test } from "bun:test";
import { tui } from "../src/index.js";

describe("TUI Host", () => {
  test("declares the interactive Host contract", () => {
    expect(tui()).toMatchObject({ name: "tui", mode: "interactive" });
  });

  test(
    "loads its Solid preload before rendering",
    async () => {
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

      // A wall-clock SIGINT raced renderer startup on cold CI runners (the signal
      // landed mid-import and was lost, leaving the renderer alive forever). Signal
      // only once the first rendered frame proves the renderer is live, and repeat
      // in case that frame beat OpenTUI's signal handler installation.
      let stdout = "";
      let interrupt: ReturnType<typeof setInterval> | undefined;
      const decoder = new TextDecoder();
      try {
        for await (const chunk of child.stdout) {
          stdout += decoder.decode(chunk, { stream: true });
          interrupt ??= setInterval(() => child.kill("SIGINT"), 500);
        }
      } finally {
        if (interrupt !== undefined) clearInterval(interrupt);
      }
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);

      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(stdout).toContain("DYNAMIC_PRELOAD_OK");
    },
    30_000,
  );
});
