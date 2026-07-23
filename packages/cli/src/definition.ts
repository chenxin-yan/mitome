import { stat } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { Option } from "effect";
import corePackage from "@mitome/core/package.json" with { type: "json" };
import { configDirectory, configDirectoryMessage } from "@mitome/core";
import { isEnoent } from "./config.js";

type Package = { readonly version?: unknown };

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

const resolvePackage = async (name: string, from: string): Promise<Package | undefined> => {
  let directory = dirname(from);
  while (true) {
    const packagePath = join(directory, "node_modules", ...name.split("/"), "package.json");
    try {
      if ((await stat(packagePath)).isFile()) {
        return JSON.parse(await Bun.file(packagePath).text()) as Package;
      }
    } catch (error) {
      // A missing node_modules while walking parents is expected; anything else
      // (for example a malformed package.json) must fail loud.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
};

export const checkRuntime = async (path: string): Promise<void> => {
  const core = await resolvePackage("@mitome/core", path);
  if (core === undefined) {
    throw new Error(
      `No @mitome/core is installed beside ${path}. Install @mitome/core@${corePackage.version} with the Agent Definition dependencies (run \`mitome install\`).`,
    );
  }
  if (core.version !== corePackage.version) {
    throw new Error(
      `@mitome/core beside ${path} is ${String(core.version)}; install @mitome/core@${corePackage.version} with the Agent Definition dependencies (run \`mitome install\`).`,
    );
  }
};
