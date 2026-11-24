#!/usr/bin/env bun
// Runs the CLI from source against the git-ignored .dev-home sandbox (ADR-0030).
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// The sources import the generated model-hint modules, which a fresh clone lacks and a branch
// switch leaves stale. Generating them reads only the repository; `vp run hints:generate` would
// also work, but downloads its package manager into a HOME that has none.
const hints = Bun.spawnSync([process.execPath, join(root, "scripts", "generate-model-hints.ts")], {
  stdout: "ignore",
  stderr: "inherit",
});
if (hints.exitCode !== 0) process.exit(hints.exitCode);

const child = Bun.spawn(
  [
    "bun",
    // The workspace packages' sources, so an edit shows without a build (vite.shared.ts).
    "--conditions=@mitome/source",
    join(root, "packages", "cli", "src", "index.ts"),
    ...process.argv.slice(2),
  ],
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
