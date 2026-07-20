#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const executable = process.platform === "win32" ? "mitome.exe" : "mitome";
// The package manager installs only the optional dependency matching this
// platform (os/cpu/libc), so try the glibc and musl flavors in detected order.
const glibc = process.report?.getReport().header.glibcVersionRuntime !== undefined;
const suffixes = process.platform === "linux" ? (glibc ? ["", "-musl"] : ["-musl", ""]) : [""];
let binary;
for (const suffix of suffixes) {
  try {
    binary = require.resolve(
      `@mitome/cli-${process.platform}-${process.arch}${suffix}/bin/${executable}`,
    );
    break;
  } catch {
    // Expected MODULE_NOT_FOUND for the flavor this platform did not install.
  }
}
if (binary === undefined) {
  console.error(
    `mitome does not ship a binary for ${process.platform}-${process.arch}. ` +
      `Check that optional dependencies were installed (@mitome/cli-${process.platform}-${process.arch}).`,
  );
  process.exit(1);
}
const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
if (result.error !== undefined) throw result.error;
process.exitCode = result.status ?? 1;
