import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
