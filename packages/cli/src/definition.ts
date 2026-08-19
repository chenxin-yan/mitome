import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { Option } from "effect";
import corePackage from "@mitome/core/package.json" with { type: "json" };
import { configDirectory, configDirectoryMessage } from "@mitome/core";
import { isEnoent } from "./config.js";

export const definitionPath = async (use: Option.Option<string>): Promise<string> => {
  const selected = Option.getOrUndefined(use);
  if (selected === undefined && configDirectory() === undefined) {
    throw new Error(`${configDirectoryMessage} Or use --use <path>.`);
  }
  let path = resolve(selected ?? join(configDirectory()!, "index.ts"));
  let file;
  try {
    file = await stat(path);
  } catch (error) {
    if (!isEnoent(error)) throw error;
    throw new Error(
      selected === undefined
        ? "No Agent Definition found; run mitome init first or use --use <path>."
        : `Agent Definition not found at ${path}; check the --use path.`,
    );
  }
  if (file.isDirectory()) {
    path = join(path, "index.ts");
    try {
      await stat(path);
    } catch (error) {
      if (!isEnoent(error)) throw error;
      throw new Error(`No Agent Definition module found at ${path}.`);
    }
  }
  if (extname(path) !== ".ts") {
    throw new Error(`Agent Definition path ${path} must be a TypeScript module.`);
  }
  return path;
};

type DependencyField =
  | "dependencies"
  | "devDependencies"
  | "optionalDependencies"
  | "peerDependencies";

const dependencyFields: ReadonlyArray<DependencyField> = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

const installedPackage = async (directory: string, name: string): Promise<string | undefined> => {
  let current = directory;
  while (true) {
    const packagePath = join(current, "node_modules", name, "package.json");
    try {
      await stat(packagePath);
      return packagePath;
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const sameDependencies = (
  manifest: Record<string, unknown>,
  lockWorkspace: Record<string, unknown>,
): boolean =>
  dependencyFields.every((field) => {
    const declared = record(manifest[field]) ?? {};
    const locked = record(lockWorkspace[field]) ?? {};
    const names = Object.keys(declared);
    return (
      names.length === Object.keys(locked).length &&
      names.every((name) => declared[name] === locked[name])
    );
  });

const missingDependency = async (
  directory: string,
  manifest: Record<string, unknown>,
): Promise<boolean> => {
  const names = ["dependencies", "devDependencies"].flatMap((field) =>
    Object.keys(record(manifest[field]) ?? {}),
  );
  for (const name of names) {
    if ((await installedPackage(directory, name)) === undefined) return true;
  }
  return false;
};

const installedCore = async (directory: string): Promise<{ version: unknown } | undefined> => {
  const packagePath = await installedPackage(directory, "@mitome/core");
  if (packagePath === undefined) return undefined;
  // A malformed installed package must fail loud rather than becoming an install loop.
  try {
    const parsed = record(JSON.parse(await readFile(packagePath, "utf8")));
    if (parsed === undefined) throw new Error("Not a JSON object.");
    return { version: parsed.version };
  } catch (error) {
    throw new Error(`Could not decode ${packagePath}.`, { cause: error });
  }
};

export const checkRuntime = async (path: string): Promise<void> => {
  const core = await installedCore(dirname(path));
  if (core === undefined) {
    throw new Error(
      `No @mitome/core is installed beside ${path} after installing Agent Definition dependencies. Add @mitome/core@${corePackage.version} to its package.json.`,
    );
  }
  if (core.version !== corePackage.version) {
    throw new Error(
      `@mitome/core beside ${path} is ${String(core.version)} after installing Agent Definition dependencies; its package.json must select @mitome/core@${corePackage.version}.`,
    );
  }
};

export const definitionNeedsReconcile = async (path: string): Promise<boolean> => {
  const directory = dirname(path);
  const core = await installedCore(directory);
  if (core === undefined || core.version !== corePackage.version) return true;

  let manifest: Record<string, unknown>;
  try {
    const parsed = record(JSON.parse(await readFile(join(directory, "package.json"), "utf8")));
    if (parsed === undefined) return true;
    manifest = parsed;
  } catch (error) {
    if (isEnoent(error)) return false;
    return true;
  }

  let lockWorkspace: Record<string, unknown> | undefined;
  try {
    // bun.lock is JSONC; Bun's jsonc import handles trailing commas and comments.
    const lock = record(
      (await import(join(directory, "bun.lock"), { with: { type: "jsonc" } })).default,
    );
    lockWorkspace = record(record(lock?.workspaces)?.[""]);
  } catch (error) {
    if ((error as { code?: string }).code !== "ERR_MODULE_NOT_FOUND") return true;
  }
  if (lockWorkspace !== undefined && !sameDependencies(manifest, lockWorkspace)) return true;
  return missingDependency(directory, manifest);
};
