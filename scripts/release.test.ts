import { expect, test } from "vite-plus/test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { checkArchives, copyNotices, releasePackages, unpublishedPackages } from "./release.ts";

const root = resolve(import.meta.dirname, "..");
const packages = releasePackages();

test("the cohort and dependency order are checked, including drift in a platform version", () => {
  const directory = mkdtempSync(join(tmpdir(), "release-cohort-"));
  try {
    for (const pkg of packages) {
      const destination = join(directory, relative(root, pkg.directory));
      mkdirSync(destination, { recursive: true });
      cpSync(join(pkg.directory, "package.json"), join(destination, "package.json"));
    }
    mkdirSync(join(directory, ".changeset"));
    cpSync(join(root, ".changeset/config.json"), join(directory, ".changeset/config.json"));
    // The first package depending on the last would be published before its dependency.
    const [first, last] = [packages[0]!, packages.at(-1)!];
    const firstPath = join(directory, relative(root, first.directory), "package.json");
    const firstManifest = readFileSync(firstPath, "utf8");
    const dependent = JSON.parse(firstManifest);
    dependent.dependencies = { ...dependent.dependencies, [last.name]: "workspace:*" };
    writeFileSync(firstPath, JSON.stringify(dependent));
    expect(() => releasePackages(directory)).toThrow(
      `${last.name} must publish before ${first.name}`,
    );
    writeFileSync(firstPath, firstManifest);
    const manifestPath = join(directory, "packages/cli/npm/cli-linux-x64/package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.version = "9.9.9";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => releasePackages(directory)).toThrow("must match the fixed release group");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("every platform package lists the notices of the native library its binary embeds", () => {
  for (const pkg of packages.filter((pkg) => pkg.name.startsWith("@mitome/cli-"))) {
    const manifest = JSON.parse(readFileSync(join(pkg.directory, "package.json"), "utf8"));
    expect(manifest.files).toEqual(
      expect.arrayContaining(["LICENSE-FFMPEG", "FFMPEG-SOURCE.md", "third-party"]),
    );
    // What the native OpenTUI packages declare for the library each binary embeds.
    expect(manifest.license).toBe("MIT AND LGPL-2.1-or-later");
  }
  const launcher = packages.find((pkg) => pkg.name === "@mitome/cli")!;
  expect(JSON.parse(readFileSync(join(launcher.directory, "package.json"), "utf8")).license).toBe(
    "MIT",
  );
});

test("pack copies every notice of the installed native package, and fails on a missing one", () => {
  const opentui = dirname(realpathSync(join(root, "packages/cli/node_modules/@opentui/core")));
  const native = join(opentui, `core-${process.platform}-${process.arch}`);
  const directory = mkdtempSync(join(tmpdir(), "release-notices-"));
  try {
    copyNotices(native, directory);
    expect(readdirSync(directory).sort()).toEqual([
      "FFMPEG-SOURCE.md",
      "LICENSE-FFMPEG",
      "third-party",
    ]);
    const copied = readdirSync(join(directory, "third-party/opentui")).sort();
    expect(copied).toEqual(
      [
        ...readdirSync(native)
          .filter((name) => /^(?:LICENSE|LICENSE-.+|AUTHORS-.+|PATENTS-.+)$/.test(name))
          .filter((name) => name !== "LICENSE-FFMPEG"),
        "README.md",
      ].sort(),
    );
    // The README identifies the repository and revision whose paths `FFMPEG-SOURCE.md` names.
    const manifest = JSON.parse(readFileSync(join(native, "package.json"), "utf8"));
    const readme = readFileSync(join(directory, "third-party/opentui/README.md"), "utf8");
    expect(readme).toContain(
      `\`@opentui/core-${process.platform}-${process.arch}\` ${manifest.version}`,
    );
    expect(readme).toContain(`built from ${manifest.repository.url}.`);
    // Packages built from scratch, so the installed one (hard-linked to Bun's cache) is untouched
    // and its own `gitHead`, present or not, decides nothing here.
    const fixture = (name: string, gitHead: string | undefined): string => {
      const native = join(directory, name);
      mkdirSync(native);
      for (const notice of ["LICENSE-FFMPEG", "FFMPEG-SOURCE.md", "LICENSE"]) {
        writeFileSync(join(native, notice), notice);
      }
      writeFileSync(
        join(native, "package.json"),
        JSON.stringify({
          name: manifest.name,
          version: manifest.version,
          repository: { url: "https://example.test/opentui" },
          gitHead,
        }),
      );
      copyNotices(native, join(directory, `from-${name}`));
      return readFileSync(join(directory, `from-${name}/third-party/opentui/README.md`), "utf8");
    };
    expect(fixture("tagged", "abc123")).toContain(
      `built from https://example.test/opentui. The files \`FFMPEG-SOURCE.md\` refers to, such as its build script, are paths in that repository at revision abc123 (version ${manifest.version}).`,
    );
    expect(fixture("untagged", undefined)).toContain(
      `are paths in that repository at the revision released as version ${manifest.version}.`,
    );
    expect(copied).toEqual(expect.arrayContaining(["LICENSE", "LICENSE-YOGA", "AUTHORS-LIBWEBP"]));
    expect(readFileSync(join(directory, "third-party/opentui/LICENSE-YOGA"), "utf8")).toBe(
      readFileSync(join(native, "LICENSE-YOGA"), "utf8"),
    );
    expect(() => copyNotices(join(opentui, "core-missing"), directory)).toThrow("ENOENT");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a retry selects only missing versions, and rejects registry errors or wrong metadata", async () => {
  const cohort = packages.slice(0, 2);
  const published = cohort[0]!;
  const missing = cohort[1]!;
  const requested: Array<string> = [];
  const pending = await unpublishedPackages(cohort, async (url) => {
    requested.push(url);
    return url.includes(`/${encodeURIComponent(published.name)}/`)
      ? Response.json({ name: published.name, version: published.version })
      : new Response(null, { status: 404 });
  });
  expect(pending).toEqual([missing]);
  expect(requested).toHaveLength(2);
  for (const status of [401, 403, 429, 500, 503]) {
    await assert.rejects(
      unpublishedPackages(cohort, async () => new Response(null, { status })),
      new RegExp(`HTTP ${status}`),
    );
  }
  await assert.rejects(
    unpublishedPackages(cohort, async () =>
      Response.json({ name: published.name, version: "9.9.9" }),
    ),
    /wrong version/,
  );
  await assert.rejects(
    unpublishedPackages(cohort, async () =>
      Response.json({ name: "wrong", version: published.version }),
    ),
    /wrong package/,
  );
  await assert.rejects(
    unpublishedPackages(cohort, async () => {
      throw new Error("network unavailable");
    }),
    /network unavailable/,
  );
});

test("tarballs must match the cohort, contain platform binaries and native notices, and resolve workspace protocols", () => {
  const directory = mkdtempSync(join(tmpdir(), "release-archives-"));
  const platform = packages.find((pkg) => pkg.name === "@mitome/cli-linux-x64")!;
  const contents = join(directory, "contents");
  const archives = join(directory, "archives");
  mkdirSync(join(contents, "package/bin"), { recursive: true });
  mkdirSync(archives);
  const pack = (
    version: string,
    effect: string,
    restricted = { os: ["linux"], cpu: ["x64"], libc: ["glibc"] },
  ): void => {
    writeFileSync(
      join(contents, "package/package.json"),
      JSON.stringify({
        name: platform.name,
        version,
        dependencies: { effect },
        ...restricted,
      }),
    );
    execFileSync("tar", ["-czf", join(archives, platform.archive), "-C", contents, "package"]);
  };
  try {
    pack(platform.version, "1.0.0");
    expect(() => checkArchives([platform], archives)).toThrow("missing its binary");
    writeFileSync(join(contents, "package/bin/mitome"), "fixture", { mode: 0o755 });
    pack(platform.version, "1.0.0");
    expect(() => checkArchives([platform], archives)).toThrow("missing LICENSE-FFMPEG");
    writeFileSync(join(contents, "package/LICENSE-FFMPEG"), "fixture");
    pack(platform.version, "1.0.0");
    expect(() => checkArchives([platform], archives)).toThrow("missing FFMPEG-SOURCE.md");
    writeFileSync(join(contents, "package/FFMPEG-SOURCE.md"), "fixture");
    mkdirSync(join(contents, "package/third-party/opentui"), { recursive: true });
    pack(platform.version, "1.0.0");
    expect(() => checkArchives([platform], archives)).toThrow("missing third-party/opentui");
    writeFileSync(join(contents, "package/third-party/opentui/LICENSE"), "fixture");
    pack(platform.version, "1.0.0");
    expect(() => checkArchives([platform], archives)).not.toThrow();
    pack(platform.version, "1.0.0", { os: ["linux"], cpu: ["x64"], libc: [] });
    expect(() => checkArchives([platform], archives)).toThrow("does not restrict its libc");
    pack("9.9.9", "1.0.0");
    expect(() => checkArchives([platform], archives)).toThrow();
    pack(platform.version, "catalog:");
    expect(() => checkArchives([platform], archives)).toThrow("retains workspace protocols");
    pack(platform.version, "1.0.0");
    writeFileSync(join(archives, "unexpected.tgz"), "unexpected");
    expect(() => checkArchives([platform], archives)).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the core tarball must export and contain the terminal subpath", () => {
  const directory = mkdtempSync(join(tmpdir(), "release-archives-"));
  const core = packages.find((pkg) => pkg.name === "@mitome/core")!;
  const contents = join(directory, "contents");
  const archives = join(directory, "archives");
  mkdirSync(join(contents, "package/dist"), { recursive: true });
  mkdirSync(archives);
  const pack = (exports: Record<string, string>): void => {
    writeFileSync(
      join(contents, "package/package.json"),
      JSON.stringify({ name: core.name, version: core.version, exports }),
    );
    execFileSync("tar", ["-czf", join(archives, core.archive), "-C", contents, "package"]);
  };
  try {
    pack({ ".": "./dist/index.js" });
    expect(() => checkArchives([core], archives)).toThrow("does not export ./terminal");
    pack({ ".": "./dist/index.js", "./terminal": "./dist/terminal.js" });
    expect(() => checkArchives([core], archives)).toThrow("missing dist/terminal.js");
    writeFileSync(join(contents, "package/dist/terminal.js"), "fixture");
    pack({ ".": "./dist/index.js", "./terminal": "./dist/terminal.js" });
    expect(() => checkArchives([core], archives)).toThrow("missing dist/terminal.d.ts");
    writeFileSync(join(contents, "package/dist/terminal.d.ts"), "fixture");
    pack({ ".": "./dist/index.js", "./terminal": "./dist/terminal.js" });
    expect(() => checkArchives([core], archives)).not.toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("publishing rejects a source that differs from npm's GitHub provenance before reading artifacts", () => {
  const result = spawnSync(
    "node",
    ["scripts/release.ts", "publish", "/nonexistent-release-artifacts"],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GITHUB_SHA: "0".repeat(40) },
    },
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Publishing source must match GITHUB_SHA for npm provenance");
});

test("the uploader's Node entry point works without installing dependencies", () => {
  // A checkout of only what the uploader reads, with no node_modules in reach.
  const directory = mkdtempSync(join(tmpdir(), "release-uploader-"));
  try {
    const files = [
      "scripts/release.ts",
      ".changeset/config.json",
      ...packages.map((pkg) => join(relative(root, pkg.directory), "package.json")),
    ];
    for (const file of files) {
      mkdirSync(dirname(join(directory, file)), { recursive: true });
      cpSync(join(root, file), join(directory, file));
    }
    // `version` reads HEAD; the commit sets its own identity and skips this machine's signing
    // and hooks.
    const settings = [
      "user.name=release-test",
      "user.email=release-test@example.invalid",
      "commit.gpgsign=false",
      "core.hooksPath=/dev/null",
    ].flatMap((setting) => ["-c", setting]);
    execFileSync("git", ["init", "-q"], { cwd: directory });
    execFileSync("git", [...settings, "commit", "-q", "--allow-empty", "-m", "fixture"], {
      cwd: directory,
    });
    expect(
      execFileSync("node", ["scripts/release.ts", "version"], {
        cwd: directory,
        encoding: "utf8",
      }).trim(),
    ).toBe(packages[0]!.version);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
