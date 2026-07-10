import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

const packageDirectory = resolve(import.meta.dir, "..");
const rootDirectory = resolve(packageDirectory, "..", "..");

const targets = [
  "bun-linux-x64-baseline",
  "bun-linux-x64-musl-baseline",
  "bun-linux-arm64",
  "bun-linux-arm64-musl",
  "bun-darwin-x64-baseline",
  "bun-darwin-arm64",
  "bun-windows-x64-baseline",
  "bun-windows-arm64",
] as const;

type Target = (typeof targets)[number];

const selected =
  process.argv
    .slice(2)
    .find((argument) => argument.startsWith("--target="))
    ?.slice(9) ?? process.env.MITOME_MATRIX_TARGET;
if (selected !== undefined && !targets.includes(selected as Target)) {
  throw new Error(`Unknown Bun matrix target: ${selected}`);
}
const buildTargets: ReadonlyArray<Target> = selected === undefined ? targets : [selected as Target];
const outputDirectory = resolve(
  process.env.MITOME_MATRIX_OUTDIR ?? join(packageDirectory, "dist", "matrix"),
);

const run = async (command: ReadonlyArray<string>, cwd = packageDirectory): Promise<void> => {
  const child = Bun.spawn([...command], { cwd, stdout: "inherit", stderr: "inherit" });
  if ((await child.exited) !== 0) throw new Error(`Command failed: ${command.join(" ")}`);
};

const artifactName = (target: Target): string =>
  `mitome-${target}${target.startsWith("bun-windows-") ? ".exe" : ""}`;

const sha256 = async (path: string): Promise<string> =>
  createHash("sha256")
    .update(new Uint8Array(await Bun.file(path).arrayBuffer()))
    .digest("hex");

await run(
  [process.execPath, join(rootDirectory, "scripts", "check-bun-version.ts"), "--release"],
  rootDirectory,
);
await rm(outputDirectory, { recursive: true, force: true });

for (const target of buildTargets) {
  const directory = join(outputDirectory, target);
  const artifact = join(directory, artifactName(target));
  await mkdir(directory, { recursive: true });
  await run([
    process.execPath,
    "build",
    "--compile",
    "--no-compile-autoload-dotenv",
    "src/index.ts",
    `--target=${target}`,
    `--outfile=${artifact}`,
  ]);
}

const entries = await readdir(outputDirectory);
if (
  entries.length !== buildTargets.length ||
  entries.some((entry) => !buildTargets.includes(entry as Target))
) {
  throw new Error("Matrix output does not contain exactly the requested artifact labels.");
}

const checksums: Array<string> = [];
for (const target of [...buildTargets].sort()) {
  const artifact = join(outputDirectory, target, artifactName(target));
  if (!(await stat(artifact)).isFile()) throw new Error(`Missing matrix artifact: ${artifact}`);
  checksums.push(`${await sha256(artifact)}  ${target}/${artifactName(target)}`);
}
await Bun.write(join(outputDirectory, "checksums.sha256"), `${checksums.join("\n")}\n`);
console.log(`Built ${buildTargets.length} Bun matrix artifact(s) in ${outputDirectory}.`);
