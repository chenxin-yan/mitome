import { mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";

const packageDirectory = process.cwd();
const babelExecutable = Bun.resolveSync("@babel/cli/bin/babel.js", import.meta.dir);
const distDirectory = join(packageDirectory, "dist");
const temporaryDirectory = await mkdtemp(join(packageDirectory, ".mitome-dist-"));

const run = async (command: ReadonlyArray<string>): Promise<void> => {
  const child = Bun.spawn([...command], {
    cwd: packageDirectory,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0) throw new Error(`Command failed: ${command.join(" ")}`);
};

try {
  await rm(distDirectory, { recursive: true, force: true });
  await run([process.execPath, "x", "tsc", "-p", "tsconfig.build.json"]);
  // Babel does not rewrite an in-place directory without source maps, so transform into a sibling.
  // Only parse JS: the pure-call plugin has no JSX syntax support, and TUI's JSX has no eligible calls.
  await run([
    process.execPath,
    babelExecutable,
    "dist",
    "--out-dir",
    temporaryDirectory,
    "--plugins",
    "annotate-pure-calls",
    "--copy-files",
    "--extensions",
    ".js",
  ]);
  await rm(distDirectory, { recursive: true, force: true });
  await rename(temporaryDirectory, distDirectory);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
