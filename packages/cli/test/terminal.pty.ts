// The compiled `mitome tui` in a real pseudo-terminal (Bun.Terminal), against the offline fixture
// application: real raw mode, real keys and real signals. Run by `bun test`; POSIX only.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const binary = fileURLToPath(new URL("../dist/local/mitome", import.meta.url));
const fixture = fileURLToPath(new URL("fixtures/app.ts", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "mitome-pty-"));
const log = join(directory, "events.log");
afterAll(() => rm(directory, { recursive: true, force: true }));
beforeEach(() => writeFile(log, ""));

// termios c_lflag bits restored when the terminal leaves raw mode (Linux and macOS values agree).
const ICANON = process.platform === "darwin" ? 0x100 : 0x2;
const ECHO = 0x8;
const enterAlternate = "\u001b[?1049h";
const leaveAlternate = "\u001b[?1049l";
const altEnter = "\u001b\r";
const tab = "\t";

const events = async () => (await readFile(log, "utf8")).split("\n").filter(Boolean);

/** Starts the binary on a fresh PTY in an empty environment, killed if it outlives the test. */
const open = (args: ReadonlyArray<string>, env: Readonly<Record<string, string>> = {}) => {
  let output = "";
  const terminal = new Bun.Terminal({
    cols: 100,
    rows: 30,
    data: (_terminal, data) => {
      output += new TextDecoder().decode(data);
    },
  });
  const child = Bun.spawn([binary, "tui", "--app", fixture, ...args], {
    terminal,
    cwd: directory,
    env: { HOME: directory, PATH: "", MITOME_FIXTURE_LOG: log, ...env },
  });
  const killer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  const until = async (check: () => boolean | Promise<boolean>, what: string) => {
    for (let attempt = 0; attempt < 500; attempt++) {
      if (await check()) return;
      await Bun.sleep(20);
    }
    throw new Error(
      `Timed out waiting for ${what}; output tail: ${JSON.stringify(output.slice(-400))}`,
    );
  };
  return {
    child,
    terminal,
    output: () => output,
    write: (text: string) => void terminal.write(text),
    /** Frames are cell diffs, so wait for single words rather than whole lines. */
    shows: (word: string) => until(() => output.includes(word), JSON.stringify(word)),
    logged: (event: string) => until(async () => (await events()).includes(event), event),
    exited: async () => {
      const code = await child.exited;
      clearTimeout(killer);
      // Let the PTY deliver what the child wrote last.
      await Bun.sleep(100);
      const restored = (terminal.localFlags & (ICANON | ECHO)) === (ICANON | ECHO);
      terminal.close();
      return { code, restored, output };
    },
  };
};

const restoredScreen = (output: string) =>
  output.includes(enterAlternate) &&
  output.lastIndexOf(leaveAlternate) > output.lastIndexOf(enterAlternate);

describe("compiled mitome tui", () => {
  test("runs repeated Turns and an approved Tool Call, then Ctrl-C restores and shuts down", async () => {
    const tui = open([]);
    await tui.shows("Ready");
    // Raw mode while the terminal is live.
    expect(tui.terminal.localFlags & ICANON).toBe(0);
    tui.write("hello");
    tui.write(altEnter);
    await tui.logged("program:hello");
    await tui.shows("succeeded;");
    tui.write("charge");
    tui.write(altEnter);
    await tui.shows("Approval");
    await tui.shows("cents:");
    expect(await events()).not.toContain("charge:250");
    tui.write(tab);
    tui.write("y");
    await tui.logged("charge:250");
    await tui.shows("charged");
    tui.write("\u0003");
    const { code, restored, output } = await tui.exited();
    expect(code).toBe(130);
    expect(restored).toBe(true);
    expect(restoredScreen(output)).toBe(true);
    expect(await events()).toEqual([
      "infra:acquire",
      "provision:echo",
      "program:hello",
      "program:charge",
      "charge:250",
      "release-model:echo",
      "infra:release",
    ]);
  });

  test("Ctrl-C during a Turn restores the terminal, then cancels it and waits for its cleanup", async () => {
    const tui = open([]);
    await tui.shows("Ready");
    tui.write("wait");
    tui.write(altEnter);
    await tui.logged("turn:wait");
    tui.write("\u0003");
    const { code, restored, output } = await tui.exited();
    expect(code).toBe(130);
    expect(restored).toBe(true);
    expect(restoredScreen(output)).toBe(true);
    expect((await events()).slice(-3)).toEqual([
      "turn:cleanup",
      "release-model:echo",
      "infra:release",
    ]);
  });

  test("SIGTERM closes like Ctrl-C", async () => {
    const tui = open([]);
    await tui.shows("Ready");
    tui.child.kill("SIGTERM");
    const { code, restored, output } = await tui.exited();
    expect(code).toBe(130);
    expect(restored).toBe(true);
    expect(restoredScreen(output)).toBe(true);
    expect((await events()).at(-1)).toBe("infra:release");
  });

  for (const [how, close] of [
    ["Ctrl-C", (tui: ReturnType<typeof open>) => tui.write("\u0003")],
    ["SIGINT", (tui: ReturnType<typeof open>) => tui.child.kill("SIGINT")],
  ] as const) {
    test(`${how} with held cleanup restores the terminal first and reports unresolved cleanup`, async () => {
      const tui = open(["--grace", "300ms"]);
      await tui.shows("Ready");
      tui.write("hold");
      tui.write(altEnter);
      await tui.logged("turn:hold");
      const started = Date.now();
      close(tui);
      const { code, restored, output } = await tui.exited();
      expect(code).toBe(1);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(restored).toBe(true);
      expect(restoredScreen(output)).toBe(true);
      // The diagnostic comes after restoration and does not claim cleanup finished.
      const diagnostic = output.indexOf("shutdown did not finish within its 300ms grace");
      expect(diagnostic).toBeGreaterThan(output.lastIndexOf(leaveAlternate));
      expect(await events()).not.toContain("infra:release");
    });
  }

  test("a startup failure exits 1 without ever entering the terminal", async () => {
    const tui = open(["--model", "scripted/defect"]);
    const { code, restored, output } = await tui.exited();
    expect(code).toBe(1);
    expect(restored).toBe(true);
    expect(output).not.toContain(enterAlternate);
    expect(output).toContain("fixture provisioning defect");
    expect(await events()).toEqual(["infra:acquire", "infra:release"]);
  });
});
