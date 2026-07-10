import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const rootDirectory = resolve(import.meta.dir, "..");

export const publicPackages = [
  "core",
  "sdk",
  "openai",
  "openai-compatible",
  "openai-codex",
  "cli",
] as const;
export const packageVersion = "0.0.1";

export type PackageManifest = {
  readonly name: string;
  readonly version: string;
  readonly license?: string;
  readonly repository?: string;
  readonly private?: boolean;
  readonly engines?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly dependencies?: Record<string, string>;
};

export const manifestFor = async (
  name: (typeof publicPackages)[number],
): Promise<PackageManifest> =>
  JSON.parse(
    await readFile(resolve(rootDirectory, "packages", name, "package.json"), "utf8"),
  ) as PackageManifest;

export const checkLockstep = async (): Promise<void> => {
  const rootManifest = JSON.parse(
    await readFile(resolve(rootDirectory, "package.json"), "utf8"),
  ) as {
    readonly workspaces?: { readonly catalog?: Record<string, string> };
  };
  if (rootManifest.workspaces?.catalog?.effect !== "4.0.0-beta.97") {
    throw new Error("Effect must remain catalog-pinned at 4.0.0-beta.97.");
  }

  for (const name of publicPackages) {
    const manifest = await manifestFor(name);
    if (manifest.version !== packageVersion) {
      throw new Error(`${manifest.name} must be version ${packageVersion}.`);
    }
    if (manifest.private === true) throw new Error(`${manifest.name} must be public.`);
    if (manifest.repository !== "https://github.com/chenxin-yan/mitome") {
      throw new Error(`${manifest.name} must declare the canonical repository.`);
    }
    if (manifest.license !== "MIT") throw new Error(`${manifest.name} must declare MIT.`);
    if (manifest.engines === undefined)
      throw new Error(`${manifest.name} must declare its runtime.`);
  }

  for (const name of ["sdk", "openai", "openai-compatible", "openai-codex"] as const) {
    const manifest = await manifestFor(name);
    if (manifest.peerDependencies?.["@mitome/core"] !== packageVersion) {
      throw new Error(`${manifest.name} must peer-depend on @mitome/core@${packageVersion}.`);
    }
    if (manifest.dependencies?.effect !== "catalog:") {
      throw new Error(`${manifest.name} must retain the exact Effect catalog pin.`);
    }
  }

  const core = await manifestFor("core");
  if (core.dependencies?.effect !== "catalog:") {
    throw new Error("@mitome/core must retain the exact Effect catalog pin.");
  }
};

if (import.meta.main) {
  await checkLockstep();
  console.log(`All ${publicPackages.length} public packages are lockstep ${packageVersion}.`);
}
