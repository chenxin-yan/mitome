import { stat } from "node:fs/promises";
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

export const checkRuntime = async (path: string): Promise<void> => {
  let packagePath;
  try {
    packagePath = Bun.resolveSync("@mitome/core/package.json", dirname(path));
  } catch {
    throw new Error(
      `No @mitome/core is installed beside ${path}. Install @mitome/core@${corePackage.version} with the Agent Definition dependencies (run \`mitome install\`).`,
    );
  }
  // A malformed package.json must fail loud.
  let core: { readonly version?: unknown };
  try {
    core = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.optional(Schema.Unknown) }))(
      JSON.parse(await Bun.file(packagePath).text()),
    );
  } catch (error) {
    throw new Error(`Could not decode ${packagePath}.`, { cause: error });
  }
  if (core.version !== corePackage.version) {
    throw new Error(
      `@mitome/core beside ${path} is ${String(core.version)}; install @mitome/core@${corePackage.version} with the Agent Definition dependencies (run \`mitome install\`).`,
    );
  }
};
