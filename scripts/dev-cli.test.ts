import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

// The fake `ant` is a POSIX shell script.
test.skipIf(process.platform === "win32")(
  "keeps the Anthropic sign-in of a source run inside the sandbox",
  () => {
    const directory = mkdtempSync(join(tmpdir(), "dev-cli-"));
    try {
      const seen = join(directory, "seen");
      writeFileSync(
        join(directory, "ant"),
        `#!/bin/sh\nprintf %s "$ANTHROPIC_CONFIG_DIR" > ${seen}\n`,
        {
          mode: 0o755,
        },
      );
      const { ANTHROPIC_CONFIG_DIR: _, XDG_CONFIG_HOME: __, ...inherited } = process.env;
      const run = Bun.spawnSync(
        [
          process.execPath,
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
          env: { ...inherited, HOME: directory, PATH: `${directory}:${dirname(process.execPath)}` },
        },
      );
      expect(run.exitCode).toBe(0);
      expect(readFileSync(seen, "utf8")).toBe(join(root, ".dev-home", "anthropic"));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
