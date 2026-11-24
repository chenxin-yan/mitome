// The compiled bare `mitome` in a real pseudo-terminal (Bun.Terminal), against the offline fixture
// Configuration: real raw mode, real keys and real signals. Runs on the Bun runtime; POSIX only, so
// it is skipped on Windows.
// @module-tag dist
import { afterAll, beforeEach, describe, expect, test } from "vite-plus/test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const binary = fileURLToPath(new URL("../dist/local/mitome", import.meta.url));
const fixture = fileURLToPath(new URL("fixtures/config", import.meta.url));
const history = fileURLToPath(new URL("fixtures/history", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "mitome-pty-"));
const log = join(directory, "events.log");
const selected = ["--config", fixture];
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
  const child = Bun.spawn([binary, ...args], {
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

describe.skipIf(process.platform === "win32")("compiled bare mitome", { timeout: 30_000 }, () => {
  test("runs repeated Turns and an approved Tool Call, then Ctrl-C restores and shuts down", async () => {
    const tui = open(selected);
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
    await tui.shows('"cents"');
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
      'request:"charged"',
      "release-model:echo",
      "infra:release",
    ]);
  });

  test("a denied Tool Call never runs, and the Model is told why", async () => {
    // Opened with no arguments: the default Configuration is index.ts under MITOME_HOME.
    const home = join(directory, "home");
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, "index.ts"),
      `export { default } from ${JSON.stringify(join(fixture, "index.ts"))};\n`,
    );
    const tui = open([], { MITOME_HOME: home });
    await tui.shows("Ready");
    tui.write("charge");
    tui.write(altEnter);
    await tui.shows("Approval");
    tui.write(tab);
    tui.write("n");
    await tui.shows("Denied");
    await tui.shows("not");
    tui.write("\u0003");
    const { code } = await tui.exited();
    expect(code).toBe(130);
    const recorded = await events();
    expect(recorded.filter((event) => event.startsWith("charge:"))).toEqual([]);
    expect(recorded.find((event) => event.startsWith("request:"))).toContain(
      "Tool call was not approved",
    );
  });

  test("Ctrl-C during a Turn restores the terminal, then cancels it and waits for its cleanup", async () => {
    const tui = open(selected);
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
    const tui = open(selected);
    await tui.shows("Ready");
    tui.child.kill("SIGTERM");
    const { code, restored, output } = await tui.exited();
    expect(code).toBe(130);
    expect(restored).toBe(true);
    expect(restoredScreen(output)).toBe(true);
    expect((await events()).at(-1)).toBe("infra:release");
  });

  test("a terminal that hangs up and goes away closes like Ctrl-C, after the Turn's cleanup", async () => {
    const tui = open(selected);
    await tui.shows("Ready");
    tui.write("wait");
    tui.write(altEnter);
    await tui.logged("turn:wait");
    // Restoring the terminal then fails, which must not count as the terminal failing.
    tui.child.kill("SIGHUP");
    tui.terminal.close();
    const { code } = await tui.exited();
    expect(code).toBe(130);
    expect((await events()).slice(-3)).toEqual([
      "turn:cleanup",
      "release-model:echo",
      "infra:release",
    ]);
  });

  for (const [how, close] of [
    ["Ctrl-C", (tui: ReturnType<typeof open>) => tui.write("\u0003")],
    ["SIGINT", (tui: ReturnType<typeof open>) => tui.child.kill("SIGINT")],
  ] as const) {
    test(`${how} with held cleanup restores the terminal first and reports unresolved cleanup`, async () => {
      const tui = open([...selected, "--grace", "300ms"]);
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

  for (const [how, close] of [
    ["Ctrl-C", (tui: ReturnType<typeof open>) => tui.write("\u0003")],
    ["SIGINT", (tui: ReturnType<typeof open>) => tui.child.kill("SIGINT")],
    ["SIGTERM", (tui: ReturnType<typeof open>) => tui.child.kill("SIGTERM")],
  ] as const) {
    test(`names a kept conversation, and once closed by ${how} says how to continue it`, async () => {
      const tui = open(["--config", history]);
      await tui.shows("Conversation");
      tui.write("hello");
      tui.write(altEnter);
      await tui.shows("heard:");
      close(tui);
      const { code, output } = await tui.exited();
      expect(code).toBe(130);
      const after = output.slice(output.lastIndexOf(leaveAlternate));
      expect(after).toMatch(/Conversation (\S+) is kept; continue it with mitome .*--continue=\1/);
    });
  }

  test("keeps the selected Configuration in the hint, quoted for the shell", async () => {
    const spaced = join(directory, "my agent");
    await mkdir(spaced, { recursive: true });
    await writeFile(
      join(spaced, "index.ts"),
      `export { default } from ${JSON.stringify(join(history, "index.ts"))};\n`,
    );
    const tui = open(["--config", spaced]);
    await tui.shows("Conversation");
    tui.write("hello");
    tui.write(altEnter);
    await tui.shows("heard:");
    tui.write("\u0003");
    const { output } = await tui.exited();
    const after = output.slice(output.lastIndexOf(leaveAlternate));
    const [, id = "", hint = ""] =
      /Conversation (\S+) is kept; continue it with (mitome [^\r\n]*)/.exec(after) ?? [];
    // A shell reads the hint back as the words that select the same Configuration.
    // The terminal's next escape sequence follows the hint on its line.
    const command = hint.split("\u001b")[0];
    const words = spawnSync("sh", ["-c", `printf '%s\\n' ${command}`], { encoding: "utf8" });
    expect(words.stdout.split("\n").slice(0, -1)).toEqual([
      "mitome",
      "--config",
      join(spaced, "index.ts"),
      `--continue=${id}`,
    ]);
  });

  test("--continue with nothing to continue exits 1 without entering the terminal", async () => {
    const tui = open(["--config", history, "--continue"]);
    const { code, output } = await tui.exited();
    expect(code).toBe(1);
    expect(output).not.toContain(enterAlternate);
    expect(output).toContain(
      `There is no conversation to continue in ${await realpath(directory)}.`,
    );
  });

  test("a startup failure exits 1 without ever entering the terminal", async () => {
    const tui = open([...selected, "--model", "scripted/defect"]);
    const { code, restored, output } = await tui.exited();
    expect(code).toBe(1);
    expect(restored).toBe(true);
    expect(output).not.toContain(enterAlternate);
    expect(output).toContain("fixture provisioning defect");
    expect(await events()).toEqual(["infra:acquire", "infra:release"]);
  });
});
