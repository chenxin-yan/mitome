import { spawn as spawnChild } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories: Array<string> = [];

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "mitome-postinstall-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "scripts"));
  await writeFile(
    join(root, "scripts", "postinstall.mjs"),
    await readFile(join(packageDirectory, "scripts", "postinstall.mjs")),
  );
  await writeFile(join(root, "package.json"), '{"name":"@mitome/cli","version":"0.0.1"}');
  return root;
};

const installedBinary = () => (process.platform === "win32" ? "mitome.exe" : "mitome");

const target = () => {
  const glibc = (
    process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined
  )?.header?.glibcVersionRuntime;
  if (process.platform === "linux" && process.arch === "x64")
    return `bun-linux-x64${glibc ? "" : "-musl"}-baseline`;
  if (process.platform === "linux" && process.arch === "arm64")
    return `bun-linux-arm64${glibc ? "" : "-musl"}`;
  if (process.platform === "darwin" && process.arch === "x64") return "bun-darwin-x64-baseline";
  if (process.platform === "darwin" && process.arch === "arm64") return "bun-darwin-arm64";
  if (process.platform === "win32" && process.arch === "x64") return "bun-windows-x64-baseline";
  if (process.platform === "win32" && process.arch === "arm64") return "bun-windows-arm64";
  throw new Error(`Unsupported fixture platform: ${process.platform}/${process.arch}`);
};

const exists = async (path: string) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

// postinstall.mjs is a plain Node script (npm runs it with node), so spawning
// it with vitest's execPath exercises the real runtime.
const run = async (root: string, base: string) => {
  const child = spawnChild(process.execPath, [join(root, "scripts", "postinstall.mjs")], {
    env: { ...process.env, MITOME_RELEASE_BASE_URL: base },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [stderr, exitCode] = await Promise.all([
    text(child.stderr),
    new Promise<number | null>((done, fail) => {
      child.once("error", fail);
      child.once("close", done);
    }),
  ]);
  return { exitCode, stderr };
};

const serve = async (
  handler: (pathname: string) => { readonly status?: number; readonly body: string | Uint8Array },
): Promise<{ readonly server: Server; readonly url: string }> => {
  const server = createServer((request, response) => {
    const { status = 200, body } = handler(new URL(request.url!, "http://localhost").pathname);
    response.statusCode = status;
    response.end(body);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("@mitome/cli postinstall", () => {
  test("downloads only the matching checksummed release binary", async () => {
    const binary = new TextEncoder().encode("fixture binary");
    const filename = `mitome-${target()}${process.platform === "win32" ? ".exe" : ""}`;
    const checksum = createHash("sha256").update(binary).digest("hex");
    const requests: Array<string> = [];
    const { server, url } = await serve((pathname) => {
      requests.push(pathname);
      if (pathname === "/checksums.sha256") return { body: `${checksum}  ${filename}\n` };
      if (pathname === `/${filename}`) return { body: binary };
      return { status: 404, body: "not found" };
    });
    const root = await fixture();
    const result = await run(root, url);
    server.close();

    expect(result).toEqual({ exitCode: 0, stderr: "" });
    expect(new Uint8Array(await readFile(join(root, "dist", installedBinary())))).toEqual(binary);
    expect(requests.sort()).toEqual(["/checksums.sha256", `/${filename}`].sort());
  });

  test("rejects a checksum mismatch without installing a binary", async () => {
    const filename = `mitome-${target()}${process.platform === "win32" ? ".exe" : ""}`;
    const { server, url } = await serve((pathname) =>
      pathname === "/checksums.sha256"
        ? { body: `${"0".repeat(64)}  ${filename}\n` }
        : { body: "fixture binary" },
    );
    const root = await fixture();
    const result = await run(root, url);
    server.close();

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Checksum mismatch");
    expect(await exists(join(root, "dist", installedBinary()))).toBe(false);
  });

  test("rejects a missing selected release binary", async () => {
    const filename = `mitome-${target()}${process.platform === "win32" ? ".exe" : ""}`;
    const { server, url } = await serve((pathname) =>
      pathname === "/checksums.sha256"
        ? { body: `${"0".repeat(64)}  ${filename}\n` }
        : { status: 404, body: "not found" },
    );
    const root = await fixture();
    const result = await run(root, url);
    server.close();

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Download failed (404)");
    expect(await exists(join(root, "dist", installedBinary()))).toBe(false);
  });
});
