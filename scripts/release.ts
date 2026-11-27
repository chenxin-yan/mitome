// Runs with plain Node and no dependencies installed, as the release workflow runs it, so it parses
// JSON itself rather than with Effect's Schema.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
// OpenTUI's native library, which each CLI binary embeds, statically links LGPL FFmpeg; its
// notices must ship with every platform package.
const ffmpegNotices = ["LICENSE-FFMPEG", "FFMPEG-SOURCE.md"];
// The library's other notices (OpenTUI's own and those of the code it embeds) ship beside them.
const otherNotice = /^(?:LICENSE|LICENSE-.+|AUTHORS-.+|PATENTS-.+)$/;
const thirdParty = "third-party/opentui";

/** Copies the notices of the native OpenTUI package at `native` into a platform package. */
export function copyNotices(native: string, destination: string): void {
  for (const notice of ffmpegNotices) {
    cpSync(join(native, notice), join(destination, notice));
  }
  const notices = readdirSync(native).filter(
    (name) => otherNotice.test(name) && !ffmpegNotices.includes(name),
  );
  assert.ok(notices.length > 0, `${native} ships no notices`);
  mkdirSync(join(destination, thirdParty), { recursive: true });
  for (const notice of notices) {
    cpSync(join(native, notice), join(destination, thirdParty, notice));
  }
  // `FFMPEG-SOURCE.md` names files by their path in OpenTUI's repository, which a platform
  // package does not otherwise identify.
  const manifest: {
    name: string;
    version: string;
    // Publishing normalizes a repository shorthand into this object.
    repository?: { url?: string };
    gitHead?: string;
  } = JSON.parse(readFileSync(join(native, "package.json"), "utf8"));
  const repository = manifest.repository?.url;
  assert.ok(repository, `${native} names no repository`);
  const revision =
    manifest.gitHead === undefined
      ? `the revision released as version ${manifest.version}`
      : `revision ${manifest.gitHead} (version ${manifest.version})`;
  writeFileSync(
    join(destination, thirdParty, "README.md"),
    `# OpenTUI\n\nThis package embeds the native library of \`${manifest.name}\` ${manifest.version}, ` +
      `built from ${repository}. The files \`FFMPEG-SOURCE.md\` refers to, such as its build ` +
      `script, are paths in that repository at ${revision}. The other notices in this directory ` +
      `are OpenTUI's own and those of the code it embeds.\n`,
  );
}

type PackageManifest = {
  name: string;
  version: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

export type ReleasePackage = {
  directory: string;
  name: string;
  version: string;
  archive: string;
};

export function releasePackages(directory = root): ReleasePackage[] {
  const platformDirectories = readdirSync(join(directory, "packages/cli/npm")).sort();
  const directories = [
    "mitome",
    "providers",
    ...platformDirectories.map((name) => `cli/npm/${name}`),
    "cli",
  ];
  const manifests = directories.map((name): PackageManifest =>
    JSON.parse(readFileSync(join(directory, "packages", name, "package.json"), "utf8")),
  );
  const config: { fixed: string[][] } = JSON.parse(
    readFileSync(join(directory, ".changeset/config.json"), "utf8"),
  );
  assert.deepEqual(manifests.map((pkg) => pkg.name).sort(), config.fixed.flat().sort());
  const version = manifests[0]!.version;
  // The release channel is stable/latest; prereleases need an explicit dist-tag policy.
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const positions = new Map(manifests.map((pkg, index) => [pkg.name, index]));
  for (const [index, pkg] of manifests.entries()) {
    assert.equal(pkg.private, undefined, `${pkg.name} must be public`);
    assert.equal(pkg.version, version, `${pkg.name} must match the fixed release group`);
    assert.match(pkg.name, /^(?:@[a-z0-9-]+\/)?[a-z0-9-]+$/);
    for (const dependency of Object.keys({
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
      ...pkg.peerDependencies,
    })) {
      const dependencyIndex = positions.get(dependency);
      if (dependencyIndex !== undefined) {
        assert.ok(dependencyIndex < index, `${dependency} must publish before ${pkg.name}`);
      }
    }
  }
  return manifests.map((pkg, index) => ({
    directory: join(directory, "packages", directories[index]!),
    name: pkg.name,
    version: pkg.version,
    archive: `${pkg.name.replace(/^@/, "").replace("/", "-")}-${pkg.version}.tgz`,
  }));
}

export async function unpublishedPackages(
  packages: ReadonlyArray<ReleasePackage>,
  request: (url: string, options: RequestInit) => Promise<Response> = fetch,
): Promise<ReleasePackage[]> {
  const missing = [];
  // Finish registry checks before the first upload, so an outage cannot start a partial release.
  for (const pkg of packages) {
    const response = await request(
      `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${pkg.version}`,
      { signal: AbortSignal.timeout(30_000) },
    );
    if (response.status === 404) {
      missing.push(pkg);
    } else {
      assert.ok(response.ok, `Registry lookup failed for ${pkg.name}: HTTP ${response.status}`);
      const metadata: { name: string; version: string } = JSON.parse(await response.text());
      assert.equal(metadata.name, pkg.name, "Registry returned the wrong package");
      assert.equal(metadata.version, pkg.version, "Registry returned the wrong version");
    }
  }
  return missing;
}

function run(command: string, args: string[], cwd = root): void {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

export function checkArchives(packages: ReadonlyArray<ReleasePackage>, directory: string): void {
  const archives = readdirSync(directory)
    .filter((name) => name.endsWith(".tgz"))
    .sort();
  assert.deepEqual(archives, packages.map((pkg) => pkg.archive).sort());
  for (const pkg of packages) {
    const archive = join(directory, pkg.archive);
    const text = execFileSync("tar", ["-xOf", archive, "package/package.json"], {
      encoding: "utf8",
    });
    const manifest: PackageManifest = JSON.parse(text);
    assert.equal(manifest.name, pkg.name);
    assert.equal(manifest.version, pkg.version);
    assert.ok(!/"(?:catalog|workspace):/.test(text), `${pkg.name} retains workspace protocols`);
    if (pkg.name === "@mitome/cli") {
      for (const platform of packages) {
        if (platform.name.startsWith("@mitome/cli-")) {
          assert.equal(manifest.optionalDependencies?.[platform.name], platform.version);
        }
      }
    }
    if (pkg.name.startsWith("@mitome/cli-")) {
      const executable = pkg.name.includes("-win32-") ? "mitome.exe" : "mitome";
      const files = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).split("\n");
      assert.ok(files.includes(`package/bin/${executable}`), `${pkg.name} is missing its binary`);
      for (const notice of ffmpegNotices) {
        assert.ok(files.includes(`package/${notice}`), `${pkg.name} is missing ${notice}`);
      }
      assert.ok(
        files.some((file) => file.startsWith(`package/${thirdParty}/`) && !file.endsWith("/")),
        `${pkg.name} is missing ${thirdParty}`,
      );
    }
  }
}

if (import.meta.main) {
  const [command = "", archiveDirectory] = process.argv.slice(2);
  const packages = releasePackages();
  const source = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  switch (command) {
    case "version":
      console.log(packages[0]!.version);
      break;
    case "pack": {
      assert.ok(archiveDirectory, "Provide an artifact directory");
      const directory = resolve(archiveDirectory);
      mkdirSync(directory, { recursive: true });
      assert.equal(readdirSync(directory).length, 0, "Artifact directory must be empty");
      // The native packages are optional dependencies of @opentui/core, installed beside it.
      const opentui = dirname(realpathSync(join(root, "packages/cli/node_modules/@opentui/core")));
      for (const pkg of packages) {
        cpSync(join(root, "LICENSE"), join(pkg.directory, "LICENSE"));
        if (pkg.name.startsWith("@mitome/cli-")) {
          copyNotices(join(opentui, pkg.name.replace("@mitome/cli-", "core-")), pkg.directory);
        }
        run(
          "bun",
          ["pm", "pack", "--filename", join(directory, pkg.archive), "--ignore-scripts"],
          pkg.directory,
        );
      }
      checkArchives(packages, directory);
      writeFileSync(join(directory, "source-sha"), `${source}\n`);
      break;
    }
    case "publish": {
      // npm provenance uses the event SHA, not the checkout's HEAD.
      assert.equal(
        source,
        process.env.GITHUB_SHA,
        "Publishing source must match GITHUB_SHA for npm provenance",
      );
      assert.ok(archiveDirectory, "Provide the checked artifact directory");
      const directory = resolve(archiveDirectory);
      assert.equal(readFileSync(join(directory, "source-sha"), "utf8").trim(), source);
      checkArchives(packages, directory);
      const missing = await unpublishedPackages(packages);
      for (const pkg of missing) {
        run("npm", [
          "publish",
          join(directory, pkg.archive),
          "--access",
          "public",
          "--tag",
          "latest",
          "--ignore-scripts",
        ]);
      }
      console.log(
        `Published ${missing.length} packages; skipped ${packages.length - missing.length} existing versions.`,
      );
      break;
    }
    case "verify-published":
      assert.deepEqual(
        (await unpublishedPackages(packages)).map((pkg) => pkg.name),
        [],
        "Cannot finalize an incomplete npm release",
      );
      break;
    default:
      throw new Error(
        "Usage: release.ts <version|pack|publish|verify-published> [artifact-directory]",
      );
  }
}
