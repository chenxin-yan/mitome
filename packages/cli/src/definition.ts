import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { Option, Schema } from "effect";
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
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;

const withoutTrailingCommas = (source: string): string => {
  let result = "";
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quoted) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    if (character === ",") {
      let next = index + 1;
      while (/\s/.test(source[next] ?? "")) next += 1;
      if (source[next] === "}" || source[next] === "]") continue;
    }
    result += character;
  }
  return result;
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
    if (!packageName.test(name)) return true;
    try {
      await stat(join(directory, "node_modules", name, "package.json"));
    } catch (error) {
      if (!isEnoent(error)) throw error;
      return true;
    }
  }
  return false;
};

export const checkRuntime = async (path: string): Promise<void> => {
  const packagePath = join(dirname(path), "node_modules", "@mitome", "core", "package.json");
  let source;
  try {
    source = await readFile(packagePath, "utf8");
  } catch (error) {
    if (!isEnoent(error)) throw error;
    throw new Error(
      `No @mitome/core is installed beside ${path} after installing Agent Definition dependencies. Add @mitome/core@${corePackage.version} to its package.json.`,
    );
  }
  const core = Schema.decodeUnknownSync(
    Schema.Struct({ version: Schema.optional(Schema.Unknown) }),
  )(JSON.parse(source));
  if (core.version !== corePackage.version) {
    throw new Error(
      `@mitome/core beside ${path} is ${String(core.version)} after installing Agent Definition dependencies; its package.json must select @mitome/core@${corePackage.version}.`,
    );
  }
};

export const definitionNeedsReconcile = async (path: string): Promise<boolean> => {
  const directory = dirname(path);
  let packagePath;
  try {
    packagePath = Bun.resolveSync("@mitome/core/package.json", directory);
  } catch {
    return true;
  }
  // A malformed installed package must fail loud rather than becoming an install loop.
  let core: { readonly version?: unknown };
  try {
    core = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.optional(Schema.Unknown) }))(
      JSON.parse(await Bun.file(packagePath).text()),
    );
  } catch (error) {
    throw new Error(`Could not decode ${packagePath}.`, { cause: error });
  }
  if (core.version !== corePackage.version) return true;

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
    const lock = record(
      JSON.parse(withoutTrailingCommas(await readFile(join(directory, "bun.lock"), "utf8"))),
    );
    lockWorkspace = record(record(lock?.workspaces)?.[""]);
  } catch (error) {
    if (!isEnoent(error)) return true;
  }
  if (lockWorkspace === undefined || !sameDependencies(manifest, lockWorkspace)) return true;
  return missingDependency(directory, manifest);
};
