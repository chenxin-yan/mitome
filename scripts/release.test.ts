import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { checkArchives, releasePackages, unpublishedPackages } from "./release.ts";

const root = resolve(import.meta.dir, "..");
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
    expect(releasePackages(directory).map((pkg) => pkg.name)).toEqual(
      packages.map((pkg) => pkg.name),
    );
    const manifestPath = join(directory, "packages/cli/npm/cli-linux-x64/package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.version = "9.9.9";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => releasePackages(directory)).toThrow("must match the fixed release group");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a retry selects only missing versions, and rejects registry errors or wrong metadata", async () => {
  const cohort = packages.slice(0, 2);
  const published = cohort[0]!;
  const missing = cohort[1]!;
  const requested: string[] = [];
  const pending = await unpublishedPackages(cohort, async (url) => {
    requested.push(url);
    return url.includes(encodeURIComponent(published.name))
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

test("tarballs must match the cohort, contain platform binaries, and resolve workspace protocols", () => {
  const directory = mkdtempSync(join(tmpdir(), "release-archives-"));
  const platform = packages.find((pkg) => pkg.name === "@mitome/cli-linux-x64")!;
  const contents = join(directory, "contents");
  const archives = join(directory, "archives");
  mkdirSync(join(contents, "package/bin"), { recursive: true });
  mkdirSync(archives);
  const pack = (version: string, effect: string): void => {
    writeFileSync(
      join(contents, "package/package.json"),
      JSON.stringify({
        name: platform.name,
        version,
        dependencies: { effect },
      }),
    );
    execFileSync("tar", ["-czf", join(archives, platform.archive), "-C", contents, "package"]);
  };
  try {
    pack(platform.version, "1.0.0");
    expect(() => checkArchives([platform], archives)).toThrow("missing its binary");
    writeFileSync(join(contents, "package/bin/mitome"), "fixture", { mode: 0o755 });
    pack(platform.version, "1.0.0");
    expect(() => checkArchives([platform], archives)).not.toThrow();
    pack("9.9.9", "1.0.0");
    expect(() => checkArchives([platform], archives)).toThrow();
    pack(platform.version, "catalog:");
    expect(() => checkArchives([platform], archives)).toThrow("retains workspace protocols");
    writeFileSync(join(archives, "unexpected.tgz"), "unexpected");
    expect(() => checkArchives([platform], archives)).toThrow();
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
  expect(
    execFileSync("node", ["scripts/release.ts", "version"], { cwd: root, encoding: "utf8" }).trim(),
  ).toBe(packages[0]!.version);
});
