import { mkdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

const packageDirectory = resolve(import.meta.dir, "..");
const outputDirectory = join(packageDirectory, "dist", "release");

// Every supported OS/arch/libc family; x64 ships baseline-only. Sorted so the
// checksum manifest is deterministic.
const targets = [
  "bun-darwin-arm64",
  "bun-darwin-x64-baseline",
  "bun-linux-arm64",
  "bun-linux-arm64-musl",
  "bun-linux-x64-baseline",
  "bun-linux-x64-musl-baseline",
  "bun-windows-arm64",
  "bun-windows-x64-baseline",
];

const artifactName = (target: string): string =>
  `mitome-${target}${target.startsWith("bun-windows-") ? ".exe" : ""}`;

const sha256 = async (path: string): Promise<string> =>
  createHash("sha256")
    .update(new Uint8Array(await Bun.file(path).arrayBuffer()))
    .digest("hex");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

const checksums: Array<string> = [];
for (const target of targets) {
  const artifact = join(outputDirectory, artifactName(target));
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
  checksums.push(`${await sha256(artifact)}  ${artifactName(target)}`);
}

await Bun.write(join(outputDirectory, "checksums.sha256"), `${checksums.join("\n")}\n`);
console.log(`Built ${targets.length} release binaries in ${outputDirectory}.`);
