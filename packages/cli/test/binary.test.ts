// The compiled `mitome` executable against the offline fixture Configuration, as an operator runs
// it: a real module import, real stdio and real signals. No network or credentials are used. The
// binary bundles its own `@mitome/core` and `effect`; the fixture imports the workspace's copies.
// @module-tag dist
import { spawn, spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { text } from "node:stream/consumers";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import cliPackage from "../package.json" with { type: "json" };
import { installCommand, type Shell, shellQuote } from "../src/template.ts";

const binary = fileURLToPath(new URL("../dist/local/mitome", import.meta.url));
const launcher = fileURLToPath(new URL("../scripts/mitome.mjs", import.meta.url));
// npm runs the launcher on Node. Under `bun --bun` the first `node` on PATH is Bun itself, and
// another may be a shim that needs PATH, which the child does not get: this asks each for the Node
// executable behind it and takes the first answer.
const realNode = () => {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const probe = spawnSync(
      join(directory, "node"),
      ["--print", "process.versions.bun ? '' : process.execPath"],
      { encoding: "utf8" },
    );
    if (probe.status === 0 && probe.stdout.trim() !== "") return probe.stdout.trim();
  }
  throw new Error("The launcher tests need Node on PATH");
};
const fixture = fileURLToPath(new URL("fixtures/config", import.meta.url));
const historyFixture = fileURLToPath(new URL("fixtures/history", import.meta.url));
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
  command = binary,
  detached = false,
) => {
  const child = spawn(command, args, {
    cwd: directory,
    env: { HOME: directory, PATH: "", MITOME_FIXTURE_LOG: log, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    detached,
  });
  child.stdin.end(stdin);
  // An external bound, so a broken shutdown fails this test instead of hanging the suite.
  const killer = setTimeout(
    () => (detached ? process.kill(-child.pid!, "SIGKILL") : child.kill("SIGKILL")),
    10_000,
  );
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
    expect(help.stdout).toContain("--config");
  });

  test("runs the selected Configuration once from an argument or piped stdin", async () => {
    await writeFile(log, "");
    const argument = await run(["run", "--config", fixture, "hello"]);
    expect(argument).toEqual({ stdout: "> echo: hello\n", stderr: "", code: 0 });
    expect(await events()).toEqual([
      "infra:acquire",
      "provision:echo",
      "program:hello",
      "release-model:echo",
      "infra:release",
    ]);

    // A relative --config resolves against the invocation directory.
    const piped = await run(["run", "--config", relative(directory, fixture)], "from a pipe\n");
    expect(piped).toEqual({ stdout: "> echo: from a pipe\n", stderr: "", code: 0 });
  });

  test("never searches the invocation directory for a Configuration or Bun configuration", async () => {
    await writeFile(log, "");
    const recording = (event: string) =>
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(log)}, "${event}\\n");\n`;
    await writeFile(
      join(directory, "index.ts"),
      `${recording("cwd:loaded")}export { default } from ${JSON.stringify(join(fixture, "index.ts"))};\n`,
    );
    await writeFile(join(directory, "preload.ts"), recording("cwd:preload"));
    await writeFile(join(directory, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
    const config = join(directory, "xdg-config");
    const result = await start(["run", "hello"], "", { XDG_CONFIG_HOME: config }).result;
    for (const file of ["index.ts", "preload.ts", "bunfig.toml"]) await rm(join(directory, file));
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`No Configuration at ${join(config, "mitome", "index.ts")}`);
    expect(await events()).toEqual([]);
  });

  test("loads only the selected file, never a similarly named module beside it", async () => {
    await writeFile(log, "");
    const selected = join(directory, "selected");
    await mkdir(selected);
    const similar = `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(log)}, "similar:loaded\\n");\nexport { default } from ${JSON.stringify(join(fixture, "index.ts"))};\n`;
    await writeFile(join(selected, "index.ts.js"), similar);
    await writeFile(join(selected, "config.ts"), similar);
    for (const [config, missing] of [
      [selected, join(selected, "index.ts")],
      [join(selected, "config"), join(selected, "config")],
    ] as const) {
      const result = await run(["run", "--config", config, "hello"]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`No Configuration at ${missing}`);
    }
    await rm(selected, { recursive: true });
    expect(await events()).toEqual([]);
  });

  test("names the package to install only when a package is missing", async () => {
    const configuration = join(directory, "uninstalled");
    await mkdir(configuration);
    const real = await realpath(configuration);
    await writeFile(join(configuration, "helper.cjs"), 'require("mitome-missing-cjs/sub");\n');
    // Installed, but without the requested subpath: the resolver's own diagnostic stands. `inner`
    // is installed only for `outer`, found from its file but not from the Configuration's.
    const outer = join(configuration, "node_modules", "outer");
    for (const [name, directory] of [
      ["sample", join(configuration, "node_modules", "sample")],
      ["inner", join(outer, "node_modules", "inner")],
    ] as const) {
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "package.json"),
        `{ "name": "${name}", "exports": { ".": "./index.js" } }\n`,
      );
      await writeFile(join(directory, "index.js"), "module.exports = 1;\n");
    }
    await writeFile(join(configuration, "subpath.cjs"), 'require("sample/missing");\n');
    await writeFile(join(outer, "package.json"), '{ "name": "outer", "main": "index.cjs" }\n');
    await writeFile(join(outer, "index.cjs"), 'require("inner/missing");\n');
    // The binary names itself as the installer, as `mitome init` does.
    const shell: Shell = process.platform === "win32" ? "powershell" : "posix";
    const install = `Install the Configuration's dependencies by running this in ${real}: ${installCommand(shellQuote(binary, shell), shell)}`;
    for (const [source, message] of [
      [
        'import "mitome-missing/sub/path";\n',
        `package "mitome-missing" is not installed. ${install}`,
      ],
      ['import "./helper.cjs";\n', `package "mitome-missing-cjs" is not installed. ${install}`],
      ['import "./missing.ts";\n', "./missing.ts"],
      ['import "sample/missing";\n', "Cannot find package 'sample'"],
      ['import "./subpath.cjs";\n', "Cannot find module 'sample/missing'"],
      ['import "outer";\n', "Cannot find module 'inner/missing'"],
    ] as const) {
      await writeFile(join(configuration, "index.ts"), source);
      const result = await run(["run", "--config", configuration, "hello"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`Could not load ${join(configuration, "index.ts")}`);
      expect(result.stderr).toContain(message);
      if (!message.includes("npm install")) expect(result.stderr).not.toContain("npm install");
    }
    await rm(configuration, { recursive: true });
  });

  test("denies a Tool Call that needs Approval, tells the Model and finishes", async () => {
    await writeFile(log, "");
    const charged = await run(["run", "--config", fixture, "charge"]);
    expect(charged).toEqual({ stdout: "> echo: not charged\n", stderr: "", code: 0 });
    const recorded = await events();
    expect(recorded.filter((event) => event.startsWith("charge:"))).toEqual([]);
    expect(recorded.find((event) => event.startsWith("request:"))).toContain(
      "Tool call needs approval and nobody is present to give it",
    );
  });

  test("exits nonzero with a diagnostic on stderr when the program fails", async () => {
    const failed = await run(["run", "--config", fixture, "fail"]);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toBe("");
    expect(failed.stderr).toContain("The Agent failed: refused: asked to fail");
  });

  test("keeps stdout to the result: Configuration logs and defects go to stderr", async () => {
    const logged = await run(["run", "--config", fixture, "log"]);
    expect(logged.code).toBe(0);
    expect(logged.stdout).toBe("> echo: log\n");
    expect(logged.stderr).toContain("fixture log line");

    const defect = await run(["run", "--config", fixture, "--model", "scripted/defect", "hi"]);
    expect(defect.code).toBe(1);
    expect(defect.stdout).toBe("");
    expect(defect.stderr).toContain("fixture provisioning defect");
  });

  test("bounds ordinary cleanup by the grace too, after writing the result", async () => {
    await writeFile(log, "");
    const started = Date.now();
    const held = await start(["run", "--config", fixture, "--grace", "300ms", "hi"], "", {
      MITOME_FIXTURE_HOLD_RELEASE: "1",
    }).result;
    expect(held.code).toBe(1);
    expect(held.stdout).toBe("> echo: hi\n");
    expect(held.stderr).toContain("shutdown did not finish within its 300ms grace");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await events()).not.toContain("infra:release");
  });

  test("bounds the unwind of a failed startup by the grace, without a signal", async () => {
    await writeFile(log, "");
    const started = Date.now();
    const failed = await start(
      ["run", "--config", fixture, "--model", "scripted/defect", "--grace", "300ms", "hi"],
      "",
      { MITOME_FIXTURE_HOLD_RELEASE: "1" },
    ).result;
    expect(failed.code).toBe(1);
    expect(failed.stdout).toBe("");
    expect(failed.stderr).toContain("shutdown did not finish within its 300ms grace");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await events()).toEqual(["infra:acquire"]);
  });

  test("labels conversations with the directory it started in, wherever the Configuration moves", async () => {
    const elsewhere = join(directory, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    const moving = join(directory, "moving.ts");
    await writeFile(
      moving,
      `process.chdir(${JSON.stringify(elsewhere)});\nexport { default } from ${JSON.stringify(join(historyFixture, "index.ts"))};\n`,
    );
    const result = await run(["run", "--config", moving, "--continue", "hi"]);
    await rm(moving);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `There is no conversation to continue in ${await realpath(directory)}.`,
    );
  });

  test("discovers Providers offline", async () => {
    await writeFile(log, "");
    const providers = await run(["providers", "--config", fixture]);
    expect(providers.code).toBe(0);
    expect(providers.stdout).toContain("scripted/echo (context window 8192)");
    const status = await run(["auth", "status", "--config", fixture]);
    expect(status.stdout).toContain("scripted: FIXTURE_API_KEY missing");
    expect(await events()).toEqual([]);
  });

  test.each(["plain", "zero"])(
    "exits 1 when an auth capability fails with a %s rejection",
    async (rejection) => {
      const { code, stderr } = await start(
        ["auth", "login", "--config", fixture, "--provider", "oauth"],
        "",
        { MITOME_FIXTURE_AUTH_REJECT: rejection },
      ).result;
      expect(stderr).toContain("oauth login failed: fixture rejection");
      expect(code).toBe(1);
    },
  );

  test("drains cleanup after SIGINT before releasing infrastructure", async () => {
    await writeFile(log, "");
    const { child, result } = start(["run", "--config", fixture, "wait"]);
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

  test.skipIf(process.platform === "win32")("shuts down on SIGHUP as on SIGTERM", async () => {
    await writeFile(log, "");
    const { child, result } = start(["run", "--config", fixture, "wait"]);
    await until("turn:wait");
    child.kill("SIGHUP");
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

  // A closing terminal signals its whole process group: the launcher and the binary both get it.
  test.skipIf(process.platform === "win32").each([
    { signal: "SIGTERM", group: false },
    { signal: "SIGHUP", group: false },
    { signal: "SIGHUP", group: true },
  ] as const)(
    "the npm launcher ends the binary gracefully on $signal (to the whole group: $group)",
    async ({ signal, group }) => {
      await writeFile(log, "");
      // The layout npm installs: the launcher beside the platform package it resolves.
      const installed = join(directory, "installed");
      const bin = join(
        installed,
        "node_modules",
        "@mitome",
        `cli-${process.platform}-${process.arch}`,
        "bin",
      );
      await mkdir(bin, { recursive: true });
      await symlink(binary, join(bin, "mitome"));
      await copyFile(launcher, join(installed, "mitome.mjs"));
      const { child, result } = start(
        [join(installed, "mitome.mjs"), "run", "--config", fixture, "wait"],
        "",
        {},
        realNode(),
        group,
      );
      await until("turn:wait");
      if (group) process.kill(-child.pid!, signal);
      else child.kill(signal);
      // `close` waits for every holder of the inherited pipes, so the binary has exited too.
      const { code, stdout } = await result;
      await rm(installed, { recursive: true });
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
    },
  );

  test("exits nonzero when cleanup outlives the grace, without releasing what it uses", async () => {
    await writeFile(log, "");
    const { child, result } = start(["run", "--config", fixture, "--grace", "300ms", "hold"]);
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

// The fake `ant` is a POSIX shell script; Windows cannot run it, so these tests are skipped there.
describe.skipIf(process.platform === "win32")("compiled mitome auth with Anthropic's ant", () => {
  const anthropicFixture = fileURLToPath(new URL("fixtures/anthropic", import.meta.url));
  const login = ["auth", "login", "--config", anthropicFixture, "--provider", "anthropic"];

  /** A directory holding only a fake `ant` that runs `script`, so PATH reaches nothing else. */
  const fakeAnt = async (script: string) => {
    const bin = await mkdtemp(join(directory, "bin-"));
    await writeFile(join(bin, "ant"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    // No real Anthropic profile is in reach either: HOME is already the test directory.
    return { PATH: bin, ANTHROPIC_CONFIG_DIR: directory };
  };

  test("exits with ant's exit status, keeping the diagnostic", async () => {
    const { code, stderr } = await start(login, "", await fakeAnt("exit 3")).result;
    expect(code).toBe(3);
    expect(stderr).toContain(
      "anthropic login failed: ant auth login --profile=mitome exited with status 3.",
    );
  });

  test("stops ant when it is stopped", async () => {
    const pidFile = join(directory, "ant.pid");
    // The fake becomes this test's own runtime, waiting; its PATH holds only the fake.
    const { child, result } = start(login, "", {
      ...(await fakeAnt(
        'echo $$ > "$ANT_PID_FILE"\nexec "$ANT_RUNTIME" -e "setTimeout(() => {}, 30000)"',
      )),
      ANT_PID_FILE: pidFile,
      ANT_RUNTIME: process.execPath,
    });
    let pid: number | undefined;
    for (let attempt = 0; attempt < 500 && pid === undefined; attempt++) {
      const text = await readFile(pidFile, "utf8").catch(() => "");
      if (text.endsWith("\n")) pid = Number(text);
      else await delay(10);
    }
    expect(pid).toBeDefined();
    const alive = () => {
      try {
        process.kill(pid!, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
      for (let attempt = 0; attempt < 200 && alive(); attempt++) await delay(10);
      expect(alive()).toBe(false);
    } finally {
      if (alive()) process.kill(pid!, "SIGKILL");
      await result;
    }
  });
});

describe("compiled mitome init", () => {
  test("writes a default Configuration that providers and run load without --config", async () => {
    // MITOME_HOME starts missing, beside a node_modules where this package's devDependencies stand
    // in for the install, so the written index.ts resolves @mitome/core and @mitome/providers.
    const root = join(directory, "init-accepted");
    const home = join(root, "home");
    await mkdir(root);
    await symlink(
      fileURLToPath(new URL("../node_modules", import.meta.url)),
      join(root, "node_modules"),
      "dir",
    );
    const env = { MITOME_HOME: home };
    const init = await start(
      ["init", "--provider", "openai", "--model", "gpt-5.6", "--no-install"],
      "",
      env,
    ).result;
    expect(init).toMatchObject({ code: 0, stderr: "" });
    expect(init.stdout).toContain(`Wrote the default Configuration to ${home}.`);

    const providers = await start(["providers"], "", env).result;
    expect(providers).toMatchObject({ code: 0, stderr: "" });
    expect(providers.stdout).toMatch(/^openai\n/);
    expect(providers.stdout).toContain("default: openai/gpt-5.6\n");

    // No credential: acquisition stops at the Provider before any request.
    const run = await start(["run", "hi"], "", env).result;
    expect(run).toMatchObject({ code: 1, stdout: "" });
    expect(run.stderr).toContain("Could not start the Configuration: ");
    expect(run.stderr).toContain("OPENAI_API_KEY");
    await rm(root, { recursive: true });
  });

  test("acts as Bun's installer when BUN_BE_BUN=1 is set", async () => {
    const scratch = join(directory, "install-scratch");
    await mkdir(scratch);
    await writeFile(join(scratch, "package.json"), '{ "name": "scratch", "private": true }\n');
    const child = spawn(binary, ["install"], {
      cwd: scratch,
      env: { HOME: directory, PATH: "", BUN_BE_BUN: "1" },
    });
    const [stdout, code] = await Promise.all([
      text(child.stdout),
      new Promise<number | null>((resolve) => child.on("close", resolve)),
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("bun install v");
    await rm(scratch, { recursive: true });
  });

  test("keeps the written files and exits nonzero when its own install fails", async () => {
    // A HOME whose global bunfig points the installer at a loopback port nothing listens on, with
    // an empty cache of its own: the install fails without the network. `offline = true` is not
    // enough, as some Bun versions still download with it.
    const root = join(directory, "init-offline");
    const home = join(root, "mitome");
    await mkdir(join(root, "cache"), { recursive: true });
    await writeFile(
      join(root, ".bunfig.toml"),
      `[install]\nregistry = "http://127.0.0.1:1/"\n\n[install.cache]\ndir = ${JSON.stringify(join(root, "cache"))}\n`,
    );
    const init = await start(
      ["init", "--provider", "anthropic", "--model", "claude-sonnet-5"],
      "",
      { HOME: root, MITOME_HOME: home },
    ).result;
    expect(init.code).toBe(1);
    expect(init.stderr).toContain(
      `Wrote the default Configuration to ${home}, but its dependencies are not installed: `,
    );
    const shell: Shell = process.platform === "win32" ? "powershell" : "posix";
    expect(init.stderr).toContain(
      `Install them by running this in ${home}: ${installCommand(shellQuote(binary, shell), shell)}`,
    );
    expect(await readFile(join(home, "index.ts"), "utf8")).toContain("providers: [anthropic()],");
    await rm(root, { recursive: true });
  });
});
