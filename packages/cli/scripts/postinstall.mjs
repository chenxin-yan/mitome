import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDirectory = resolve(packageDirectory, "..", "..");

const isWorkspace = async () => {
  try {
    const manifest = JSON.parse(await readFile(join(workspaceDirectory, "package.json"), "utf8"));
    return manifest.workspaces !== undefined;
  } catch (error) {
    // Expected for an installed package: node_modules has no package manifest.
    if (error?.code === "ENOENT") return false;
    throw error;
  }
};

const linuxTarget = () => {
  const glibc = process.report?.getReport().header.glibcVersionRuntime;
  if (typeof glibc === "string" && glibc !== "") return "";
  const ldd = spawnSync("ldd", ["--version"], { encoding: "utf8" });
  const output = `${ldd.stdout}${ldd.stderr}`.toLowerCase();
  if (output.includes("musl")) return "-musl";
  if (output.includes("glibc") || output.includes("gnu libc")) return "";
  throw new Error("Unable to determine Linux libc; refusing binary download.");
};

export const targetFor = (platform = process.platform, arch = process.arch) => {
  if (platform === "linux") {
    if (arch === "x64") return `bun-linux-x64${linuxTarget()}-baseline`;
    if (arch === "arm64") return `bun-linux-arm64${linuxTarget()}`;
  }
  if (platform === "darwin" && arch === "x64") return "bun-darwin-x64-baseline";
  if (platform === "darwin" && arch === "arm64") return "bun-darwin-arm64";
  if (platform === "win32" && arch === "x64") return "bun-windows-x64-baseline";
  if (platform === "win32" && arch === "arm64") return "bun-windows-arm64";
  throw new Error(`Unsupported platform: ${platform}/${arch}.`);
};

const checksumFor = (manifest, filename) => {
  let checksum;
  for (const line of manifest.trim().split("\n")) {
    const match = /^([a-f\d]{64})  ([^\s]+)$/i.exec(line);
    if (match === null) throw new Error("Invalid checksums.sha256 manifest.");
    if (match[2] === filename) {
      if (checksum !== undefined) throw new Error(`Duplicate checksum for ${filename}.`);
      checksum = match[1].toLowerCase();
    }
  }
  if (checksum === undefined) throw new Error(`Missing checksum for ${filename}.`);
  return checksum;
};

const download = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  return new Uint8Array(await response.arrayBuffer());
};

export const install = async () => {
  const manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
  const target = targetFor();
  const filename = `mitome-${target}${process.platform === "win32" ? ".exe" : ""}`;
  const base =
    process.env.MITOME_RELEASE_BASE_URL ??
    `https://github.com/chenxin-yan/mitome/releases/download/v${manifest.version}`;
  const release = base.replace(/\/$/, "");
  const [checksums, binary] = await Promise.all([
    download(`${release}/checksums.sha256`).then((value) => new TextDecoder().decode(value)),
    download(`${release}/${filename}`),
  ]);
  const expected = checksumFor(checksums, filename);
  const actual = createHash("sha256").update(binary).digest("hex");
  if (actual !== expected) throw new Error(`Checksum mismatch for ${filename}.`);

  const destination = join(
    packageDirectory,
    "dist",
    process.platform === "win32" ? "mitome.exe" : "mitome",
  );
  const temporary = `${destination}.${process.pid}.tmp`;
  await mkdir(dirname(destination), { recursive: true });
  await rm(destination, { force: true });
  try {
    await writeFile(temporary, binary, { mode: 0o755 });
    if (process.platform !== "win32") await chmod(temporary, 0o755);
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
};

// ponytail: workspace installs must not fetch unpublished release assets.
if (process.argv[1] === fileURLToPath(import.meta.url) && !(await isWorkspace())) await install();
