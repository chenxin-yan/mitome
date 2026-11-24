#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const executable = process.platform === "win32" ? "mitome.exe" : "mitome";
// The package manager installs only the optional dependency matching this
// platform (os/cpu/libc), so try the glibc and musl flavors in detected order.
const glibc = process.report.getReport().header.glibcVersionRuntime !== undefined;
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
const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });
// A signal that ends only this launcher would orphan the binary before its shutdown grace begins.
const signals = ["SIGHUP", "SIGINT", "SIGTERM"];
const forward = (signal) => {
  // On Windows the binary gets a console Ctrl+C or close itself; kill() cannot forward it gently.
  if (signal !== "SIGTERM" && process.platform === "win32") return;
  child.kill(signal);
};
for (const signal of signals) process.on(signal, forward);
child.on("error", (error) => {
  throw error;
});
child.on("exit", (code, signal) => {
  for (const name of signals) process.off(name, forward);
  if (signal === null) process.exitCode = code ?? 1;
  else process.kill(process.pid, signal);
});
