import { join, resolve } from "node:path";

const packageDirectory = resolve(import.meta.dir, "..");

// Every supported OS/arch/libc family; x64 ships baseline-only. Each Bun
// compile target maps onto the platform package that publishes its binary.
const targets = {
  "bun-darwin-arm64": "cli-darwin-arm64",
  "bun-darwin-x64-baseline": "cli-darwin-x64",
  "bun-linux-arm64": "cli-linux-arm64",
  "bun-linux-arm64-musl": "cli-linux-arm64-musl",
  "bun-linux-x64-baseline": "cli-linux-x64",
  "bun-linux-x64-musl-baseline": "cli-linux-x64-musl",
  "bun-windows-arm64": "cli-win32-arm64",
  "bun-windows-x64-baseline": "cli-win32-x64",
};

for (const [target, packageName] of Object.entries(targets)) {
  const executable = target.startsWith("bun-windows-") ? "mitome.exe" : "mitome";
  const artifact = join(packageDirectory, "npm", packageName, "bin", executable);
  const child = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      "--no-compile-autoload-dotenv",
      "src/index.ts",
      `--target=${target}`,
      `--outfile=${artifact}`,
    ],
    { cwd: packageDirectory, stdout: "inherit", stderr: "inherit" },
  );
  if ((await child.exited) !== 0) throw new Error(`Build failed for ${target}`);
}

console.log(`Built ${Object.keys(targets).length} platform package binaries.`);
