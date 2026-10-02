// The compiled `mitome` executable against the offline fixture application, as an operator runs
// it: a real module import, real stdio and real signals. No network or credentials are used.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { text } from "node:stream/consumers";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import cliPackage from "../package.json" with { type: "json" };

const binary = fileURLToPath(new URL("../dist/local/mitome", import.meta.url));
const fixture = fileURLToPath(new URL("fixtures/app.ts", import.meta.url));
let directory = "";
let log = "";

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "mitome-binary-"));
  log = join(directory, "events.log");
});
afterAll(() => rm(directory, { recursive: true, force: true }));

const events = async () => (await readFile(log, "utf8")).split("\n").filter(Boolean);

/** Starts the binary in an empty directory with no inherited credentials. */
const start = (
  args: ReadonlyArray<string>,
  stdin = "",
  env: Readonly<Record<string, string>> = {},
) => {
  const child = spawn(binary, args, {
    cwd: directory,
    env: { HOME: directory, PATH: "", MITOME_FIXTURE_LOG: log, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(stdin);
  // An external bound, so a broken shutdown fails this test instead of hanging the suite.
  const killer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const result = Promise.all([
    text(child.stdout),
    text(child.stderr),
    new Promise<number | null>((resolve) => child.on("close", resolve)),
  ]).then(([stdout, stderr, code]) => {
    clearTimeout(killer);
    return { stdout, stderr, code };
  });
  return { child, result };
};

const run = (args: ReadonlyArray<string>, stdin?: string) => start(args, stdin).result;

const until = async (event: string) => {
  for (let attempt = 0; attempt < 500; attempt++) {
    if ((await events().catch((): Array<string> => [])).includes(event)) return;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${event}`);
};

describe("compiled mitome", () => {
  test("prints help and version", async () => {
    expect((await run(["--version"])).stdout).toBe(`mitome v${cliPackage.version}\n`);
    const help = await run(["run", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("--app");
  });

  test("runs the explicit application once from an argument or piped stdin", async () => {
    await writeFile(log, "");
    const argument = await run(["run", "--app", fixture, "hello"]);
    expect(argument).toEqual({ stdout: "> echo: hello\n", stderr: "", code: 0 });
    expect(await events()).toEqual([
      "infra:acquire",
      "provision:echo",
      "program:hello",
      "release-model:echo",
      "infra:release",
    ]);

    // A relative --app resolves against the invocation directory.
    const piped = await run(["run", "--app", relative(directory, fixture)], "from a pipe\n");
    expect(piped).toEqual({ stdout: "> echo: from a pipe\n", stderr: "", code: 0 });
  });

  test("exits nonzero with a diagnostic on stderr when the program fails", async () => {
    const failed = await run(["run", "--app", fixture, "fail"]);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toBe("");
    expect(failed.stderr).toContain("The application failed: refused: asked to fail");
  });

  test("keeps stdout to the result: application logs and defects go to stderr", async () => {
    const logged = await run(["run", "--app", fixture, "log"]);
    expect(logged.code).toBe(0);
    expect(logged.stdout).toBe("> echo: log\n");
    expect(logged.stderr).toContain("fixture log line");

    const defect = await run(["run", "--app", fixture, "--model", "scripted/defect", "hi"]);
    expect(defect.code).toBe(1);
    expect(defect.stdout).toBe("");
    expect(defect.stderr).toContain("fixture provisioning defect");
  });

  test("bounds ordinary cleanup by the grace too, after writing the result", async () => {
    await writeFile(log, "");
    const started = Date.now();
    const held = await start(["run", "--app", fixture, "--grace", "300ms", "hi"], "", {
      MITOME_FIXTURE_HOLD_RELEASE: "1",
    }).result;
    expect(held.code).toBe(1);
    expect(held.stdout).toBe("> echo: hi\n");
    expect(held.stderr).toContain("shutdown did not finish within its 300ms grace");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await events()).not.toContain("infra:release");
  });

  test("discovers Providers offline", async () => {
    await writeFile(log, "");
    const providers = await run(["providers", "--app", fixture]);
    expect(providers.code).toBe(0);
    expect(providers.stdout).toContain("scripted/echo (context window 8192)");
    const status = await run(["auth", "status", "--app", fixture]);
    expect(status.stdout).toContain("scripted: FIXTURE_API_KEY missing");
    expect(await events()).toEqual([]);
  });

  test("drains cleanup after SIGINT before releasing infrastructure", async () => {
    await writeFile(log, "");
    const { child, result } = start(["run", "--app", fixture, "wait"]);
    await until("turn:wait");
    child.kill("SIGINT");
    const { code, stdout } = await result;
    expect(code).toBe(130);
    expect(stdout).toBe("");
    expect(await events()).toEqual([
      "infra:acquire",
      "provision:echo",
      "program:wait",
      "turn:wait",
      "turn:cleanup",
      "release-model:echo",
      "infra:release",
    ]);
  });

  test("exits nonzero when cleanup outlives the grace, without releasing what it uses", async () => {
    await writeFile(log, "");
    const { child, result } = start(["run", "--app", fixture, "--grace", "300ms", "hold"]);
    await until("turn:hold");
    const signalled = Date.now();
    child.kill("SIGINT");
    const { code, stderr } = await result;
    const elapsed = Date.now() - signalled;
    expect(code).toBe(1);
    expect(stderr).toContain("shutdown did not finish within its 300ms grace");
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(5_000);
    expect(await events()).not.toContain("infra:release");
  });
});
