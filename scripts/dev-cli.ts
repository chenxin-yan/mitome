#!/usr/bin/env bun
// Runs the CLI from source against the git-ignored .dev-home sandbox (ADR-0030).
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const child = Bun.spawn(
  ["bun", join(root, "packages", "cli", "src", "index.ts"), ...process.argv.slice(2)],
  {
    env: {
      ...process.env,
      MITOME_HOME: join(root, ".dev-home"),
      // The Anthropic sign-in lives in Anthropic's config directory, not in MITOME_HOME.
      ANTHROPIC_CONFIG_DIR: join(root, ".dev-home", "anthropic"),
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.exitCode = await child.exited;
