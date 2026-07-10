import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const binary = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  process.platform === "win32" ? "mitome.exe" : "mitome",
);
const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
if (result.error !== undefined) throw result.error;
process.exitCode = result.status ?? 1;
