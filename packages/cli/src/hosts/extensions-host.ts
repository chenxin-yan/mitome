// Runs inside a disposable Bun process beside the selected Agent Definition.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AnyExtension, MitomeDefinition } from "@mitome/core";

const definitionPath = process.argv[1]!;
const outputPath = process.argv[2]!;
const corePath = Bun.resolveSync("@mitome/core", dirname(definitionPath));
const effectPath = Bun.resolveSync("effect", dirname(corePath));
const core: typeof import("@mitome/core") = await import(pathToFileURL(corePath).href);
const effect: typeof import("effect") = await import(pathToFileURL(effectPath).href);
const loaded: unknown = (
  (await import(pathToFileURL(definitionPath).href)) as { readonly default: unknown }
).default;
const definition = loaded as Partial<MitomeDefinition> | undefined;
if (definition?.agent === undefined) {
  throw new Error("The selected module must default-export defineMitome({ agent, hosts }).");
}

const errorMessage = (error: unknown): string => {
  const head =
    typeof error === "object" && error !== null && "_tag" in error && "message" in error
      ? `${String(error._tag)}: ${String(error.message)}`
      : error instanceof Error
        ? error.message
        : String(error);
  const cause =
    typeof error === "object" && error !== null && "cause" in error ? error.cause : undefined;
  return cause === undefined ? head : `${head}\n  cause: ${errorMessage(cause)}`;
};

const packageVersion = async (name: string): Promise<string> => {
  let current = dirname(definitionPath);
  while (true) {
    const packagePath = join(current, "node_modules", name, "package.json");
    try {
      const value: unknown = JSON.parse(await readFile(packagePath, "utf8"));
      return typeof value === "object" &&
        value !== null &&
        "version" in value &&
        typeof value.version === "string"
        ? value.version
        : "unknown";
    } catch (error) {
      if ((error as { readonly code?: string }).code !== "ENOENT") return "unknown";
    }
    const parent = dirname(current);
    if (parent === current) return "unknown";
    current = parent;
  }
};

try {
  const compiled = await effect.Effect.runPromise(core.compileAgentDefinition(definition.agent));
  const directNames = new Set(definition.agent.extensions.map(({ name }) => name));
  const extensions = await Promise.all(
    compiled.extensions.map(async (extension) => ({
      name: extension.name,
      version: await packageVersion(extension.name),
      direct: directNames.has(extension.name),
      dependents: compiled.extensions
        .filter((dependent) =>
          dependent.dependencies?.some(
            (dependency: AnyExtension) => dependency.name === extension.name,
          ),
        )
        .map(({ name }) => name),
    })),
  );
  await Bun.write(outputPath, JSON.stringify(extensions));
  process.exit(0);
} catch (error) {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exit(1);
}
