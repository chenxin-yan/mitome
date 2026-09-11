import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { Option, Result, Schema } from "effect";
import corePackage from "@mitome/core/package.json" with { type: "json" };
import { configDirectory, configDirectoryMessage } from "@mitome/core";
import { isEnoent } from "./config.js";

export const definitionPath = async (use: Option.Option<string>): Promise<string> => {
  const selected = Option.getOrUndefined(use);
  const directory = configDirectory();
  let path: string;
  if (selected !== undefined) {
    path = resolve(selected);
  } else {
    if (directory === undefined) throw new Error(`${configDirectoryMessage} Or use --use <path>.`);
    path = resolve(join(directory, "index.ts"));
  }
  let file;
  try {
    file = await stat(path);
  } catch (error) {
    if (!isEnoent(error)) throw error;
    throw new Error(
      selected === undefined
        ? "No Mitome Definition found; run mitome init first or use --use <path>."
        : `Mitome Definition not found at ${path}; check the --use path.`,
    );
  }
  if (file.isDirectory()) {
    path = join(path, "index.ts");
    try {
      await stat(path);
    } catch (error) {
      if (!isEnoent(error)) throw error;
      throw new Error(`No Mitome Definition module found at ${path}.`);
    }
  }
  if (extname(path) !== ".ts") {
    throw new Error(`Mitome Definition path ${path} must be a TypeScript module.`);
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

type JsonObject = Schema.JsonObject;

const JsonObject = Schema.Record(Schema.String, Schema.Json);
const decodeJsonObject = (value: Schema.Json): JsonObject | undefined => {
  const decoded = Schema.decodeUnknownResult(JsonObject)(value);
  return Result.isSuccess(decoded) ? decoded.success : undefined;
};

const dependencyRecord = (value: Schema.Json | undefined): Readonly<Record<string, Schema.Json>> =>
  value === undefined ? {} : (decodeJsonObject(value) ?? {});

const sameDependencies = (manifest: JsonObject, lockWorkspace: JsonObject): boolean =>
  dependencyFields.every((field) => {
    const declared = dependencyRecord(manifest[field]);
    const locked = dependencyRecord(lockWorkspace[field]);
    const names = Object.keys(declared);
    return (
      names.length === Object.keys(locked).length &&
      names.every((name) => declared[name] === locked[name])
    );
  });

const missingDependency = async (directory: string, manifest: JsonObject): Promise<boolean> => {
  const names = ["dependencies", "devDependencies"].flatMap((field) =>
    Object.keys(dependencyRecord(manifest[field])),
  );
  for (const name of names) {
    if ((await installedPackage(directory, name)) === undefined) return true;
  }
  return false;
};

const installedCore = async (
  directory: string,
): Promise<{ readonly version: Schema.Json | undefined } | undefined> => {
  const packagePath = await installedPackage(directory, "@mitome/core");
  if (packagePath === undefined) return undefined;
  // A malformed installed package must fail loud rather than becoming an install loop.
  try {
    const parsed = decodeJsonObject(JSON.parse(await readFile(packagePath, "utf8")));
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
      `No @mitome/core is installed beside ${path} after installing Mitome Definition dependencies. Add @mitome/core@${corePackage.version} to its package.json.`,
    );
  }
  if (core.version !== corePackage.version) {
    throw new Error(
      `@mitome/core beside ${path} is ${JSON.stringify(core.version)} after installing Mitome Definition dependencies; its package.json must select @mitome/core@${corePackage.version}.`,
    );
  }
};

export const definitionNeedsReconcile = async (path: string): Promise<boolean> => {
  const directory = dirname(path);
  const core = await installedCore(directory);
  if (core === undefined || core.version !== corePackage.version) return true;

  let manifest: JsonObject;
  try {
    const parsed = decodeJsonObject(
      JSON.parse(await readFile(join(directory, "package.json"), "utf8")),
    );
    if (parsed === undefined) return true;
    manifest = parsed;
  } catch (error) {
    if (isEnoent(error)) return false;
    return true;
  }

  let lockWorkspace: JsonObject | undefined;
  const lockPath = join(directory, "bun.lock");
  let hasLock = true;
  try {
    await stat(lockPath);
  } catch (error) {
    if (!isEnoent(error)) return true;
    hasLock = false;
  }
  if (hasLock) {
    try {
      // bun.lock is JSONC; Bun's jsonc import handles trailing commas and comments.
      const lock = decodeJsonObject((await import(lockPath, { with: { type: "jsonc" } })).default);
      const workspaces =
        lock?.workspaces === undefined ? undefined : decodeJsonObject(lock.workspaces);
      lockWorkspace = workspaces?.[""] === undefined ? undefined : decodeJsonObject(workspaces[""]);
    } catch {
      return true;
    }
  }
  if (lockWorkspace !== undefined && !sameDependencies(manifest, lockWorkspace)) return true;
  return missingDependency(directory, manifest);
};
