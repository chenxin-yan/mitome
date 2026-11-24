import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { exampleAgentSource } from "create-mitome/template";
import { expect, test } from "vite-plus/test";

const root = resolve(import.meta.dirname, "..");

// The fake `ant` is a POSIX shell script.
test.skipIf(process.platform === "win32")(
  "keeps the Anthropic sign-in of a source run inside the sandbox",
  () => {
    const directory = mkdtempSync(join(tmpdir(), "dev-cli-"));
    try {
      const seen = join(directory, "seen");
      writeFileSync(
        join(directory, "ant"),
        '#!/bin/sh\nprintf %s "$ANTHROPIC_CONFIG_DIR" > "$SEEN"\n',
        {
          mode: 0o755,
        },
      );
      const { ANTHROPIC_CONFIG_DIR: _, XDG_CONFIG_HOME: __, ...inherited } = process.env;
      // dev-cli.ts runs on Bun and starts `bun` by name, so the narrowed PATH holds a link named so:
      // an npm-installed Bun's executable is `bun.exe`, in a directory with no `bun`.
      const bun = execFileSync("bun", ["--print", "process.execPath"], { encoding: "utf8" }).trim();
      symlinkSync(bun, join(directory, "bun"));
      const run = spawnSync(
        bun,
        [
          join(root, "scripts", "dev-cli.ts"),
          "auth",
          "logout",
          "--provider",
          "anthropic",
          "--config",
          join(root, "packages", "cli", "test", "fixtures", "anthropic", "index.ts"),
        ],
        {
          // Only the fake `ant` and Bun are in reach, and no real profile is under HOME.
          env: { ...inherited, HOME: directory, PATH: directory, SEEN: seen },
        },
      );
      expect(run.status).toBe(0);
      expect(readFileSync(seen, "utf8")).toBe(join(root, ".dev-home", "anthropic"));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("dev/agent is the example Agent mitome init writes", () => {
  expect(readFileSync(join(root, "dev", "agent", "agent.ts"), "utf8")).toBe(exampleAgentSource);
});

// The fake `ant` is a POSIX shell script.
test.skipIf(process.platform === "win32")(
  "runs dev/agent from source and keeps every Mitome and Anthropic directory out of HOME",
  // Four source runs of the CLI, each a cold start of Bun.
  { timeout: 30_000 },
  () => {
    const home = mkdtempSync(join(tmpdir(), "dev-cli-home-"));
    const bin = mkdtempSync(join(tmpdir(), "dev-cli-bin-"));
    try {
      const seen = join(bin, "seen");
      writeFileSync(
        join(bin, "ant"),
        '#!/bin/sh\nprintf "%s %s %s" "$MITOME_HOME" "$ANTHROPIC_CONFIG_DIR" "$*" > "$SEEN"\n',
        {
          mode: 0o755,
        },
      );
      const {
        ANTHROPIC_API_KEY: _,
        ANTHROPIC_CONFIG_DIR: __,
        MITOME_HOME: ___,
        OPENAI_API_KEY: ____,
        XDG_CONFIG_HOME: _____,
        XDG_STATE_HOME: ______,
        ...inherited
      } = process.env;
      const devCli = (...args: Array<string>) =>
        spawnSync("bun", [join(root, "scripts", "dev-cli.ts"), "--", ...args], {
          // Bun also reads a `.env` in the directory it starts in, so not one that may hold a key.
          cwd: home,
          encoding: "utf8",
          env: {
            ...inherited,
            HOME: home,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            SEEN: seen,
            // Bun's own transpiler cache would go under HOME, which must stay empty.
            BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
          },
        });

      const providers = devCli("providers");
      expect(providers.status).toBe(0);
      expect(providers.stdout).toContain("default: openai-codex/gpt-5.5");

      const run = devCli("run", "Roll a die.", "--model", "openai/gpt-5.6");
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("OPENAI_API_KEY");

      // Input after the CLI's own `--` reaches the command unchanged, dash and all.
      const dashed = devCli("run", "--model", "openai/gpt-5.6", "--", "-hello");
      expect(dashed.status).toBe(1);
      expect(dashed.stderr).toContain("OPENAI_API_KEY");

      const login = devCli("auth", "login", "--provider", "anthropic");
      expect(login.status).toBe(0);
      expect(readFileSync(seen, "utf8")).toBe(
        `${join(root, ".dev-home")} ${join(root, ".dev-home", "anthropic")} auth login --profile=mitome`,
      );

      const selected = devCli(
        "providers",
        "--config",
        join(root, "packages", "cli", "test", "fixtures", "config"),
      );
      expect(selected.status).toBe(0);
      expect(selected.stdout).toContain("scripted/echo");

      expect(readdirSync(home)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  },
);
