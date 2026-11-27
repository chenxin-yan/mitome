#!/usr/bin/env bun
// Runs the CLI from source against the tracked development Configuration in dev/agent, with
// Mitome's state and config in the git-ignored .dev-home sandbox (ADR-0030).
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
// pnpm passes on the `--` that ends its own options in `pnpm run dev:cli -- <arguments>`.
const args = process.argv[2] === "--" ? process.argv.slice(3) : process.argv.slice(2);
// Everything after a `--` is input for the CLI's command, so flags are read and added before it.
const end = args.includes("--") ? args.indexOf("--") : args.length;
const flags = args.slice(0, end);
// `init` writes the default Configuration into .dev-home and selects none.
const selected =
  flags[0] === "init" || flags.some((arg) => arg === "--config" || arg.startsWith("--config="));

// The sources import the generated model-hint modules, which a fresh clone lacks and a branch
// switch leaves stale. Generating them reads only the repository; `vp run hints:generate` would
// also work, but downloads its package manager into a HOME that has none.
const hints = Bun.spawnSync([process.execPath, join(root, "scripts", "generate-model-hints.ts")], {
  stdout: "ignore",
  stderr: "inherit",
});
if (hints.exitCode !== 0) {
  process.exit(hints.exitCode);
}

const child = Bun.spawn(
  [
    "bun",
    // The workspace packages' sources, so an edit shows without a build (vite.shared.ts).
    "--conditions=@mitome/source",
    join(root, "packages", "cli", "src", "index.ts"),
    ...flags,
    ...(selected ? [] : ["--config", join(root, "dev", "agent")]),
    ...args.slice(end),
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
