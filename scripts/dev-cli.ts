#!/usr/bin/env bun
// Runs the CLI from source against the git-ignored .dev-home sandbox (ADR-0030).
// Bootstrap the sandbox yourself with `bun run dev:cli init`. Each run then
// re-points it at the workspace: @mitome/* dependency versions become
// workspace:* and their node_modules entries become symlinks into packages/,
// so runs exercise local source instead of the stale published packages.
// Build output is shown only on failure.
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";

const ManifestFromJson = Schema.fromJsonString(
  Schema.Struct({
    dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
);

const root = fileURLToPath(new URL("..", import.meta.url));
const home = join(root, ".dev-home");
const manifestPath = join(home, "package.json");

if (existsSync(manifestPath)) {
  const manifest = Schema.decodeSync(ManifestFromJson, {
    onExcessProperty: "preserve",
  })(await readFile(manifestPath, "utf8"));
  const dependencies = { ...manifest.dependencies };
  // core is no direct dependency, but the run host resolves it beside the definition.
  const names = new Set([...Object.keys(dependencies), "@mitome/core"]);
  const workspace = [...names].filter(
    (name) =>
      name.startsWith("@mitome/") &&
      existsSync(join(root, "packages", name.slice("@mitome/".length))),
  );
  await mkdir(join(home, "node_modules", "@mitome"), { recursive: true });
  for (const name of workspace) {
    const link = join(home, "node_modules", name);
    await rm(link, { recursive: true, force: true });
    await symlink(join("..", "..", "..", "packages", name.slice("@mitome/".length)), link);
  }
  const patched = workspace.filter(
    (name) => dependencies[name] !== undefined && dependencies[name] !== "workspace:*",
  );
  for (const name of patched) dependencies[name] = "workspace:*";
  if (patched.length > 0) {
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, dependencies }, null, 2)}\n`);
  }
  // A lockfile from `init` pins published versions; it can never match the
  // workspace:* manifest, so reconcile would force a doomed `bun install`.
  await rm(join(home, "bun.lock"), { force: true });
}

// The definition side needs sdk/extensions dist too; `@mitome/cli^...` alone only
// covers the CLI's own imports (core, providers).
const build = Bun.spawnSync(
  [
    join(root, "node_modules", ".bin", "turbo"),
    "run",
    "build",
    "--filter=@mitome/cli^...",
    "--filter=@mitome/sdk",
    "--output-logs=errors-only",
  ],
  {
    cwd: root,
    env: { ...process.env, TURBO_NO_UPDATE_NOTIFIER: "1" },
    stdout: "pipe",
    stderr: "pipe",
  },
);
if (build.exitCode !== 0) {
  process.stdout.write(build.stdout);
  process.stderr.write(build.stderr);
  process.exit(build.exitCode);
}

const child = Bun.spawn(
  ["bun", join(root, "packages", "cli", "src", "index.ts"), ...process.argv.slice(2)],
  {
    cwd: join(root, "packages", "cli"),
    env: { ...process.env, MITOME_HOME: home },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.exitCode = await child.exited;
