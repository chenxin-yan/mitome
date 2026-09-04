// Runs inside a disposable Bun process beside the selected Agent Definition.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { MitomeDefinition } from "@mitome/core";

const definitionPath = process.argv[1]!;
const outputPath = process.argv[2]!;
const corePath = Bun.resolveSync("@mitome/core", dirname(definitionPath));
const effectPath = Bun.resolveSync("effect", dirname(corePath));
const core: typeof import("@mitome/core") = await import(pathToFileURL(corePath).href);
const effect: typeof import("effect") = await import(pathToFileURL(effectPath).href);
// SAFETY: Dynamic import namespaces expose their module's default export at `.default`.
const loaded: unknown = (
  (await import(pathToFileURL(definitionPath).href)) as { readonly default: unknown }
).default;
interface DefinitionCandidate {
  readonly agent?: { readonly extensions?: ReadonlyArray<object> };
}

const isMitomeDefinition = (value: DefinitionCandidate): value is MitomeDefinition =>
  "agent" in value &&
  value.agent instanceof Object &&
  "extensions" in value.agent &&
  Array.isArray(value.agent.extensions);
if (!(loaded instanceof Object)) {
  throw new Error("The selected module must default-export defineMitome({ agent, hosts }).");
}
if (!isMitomeDefinition(loaded)) {
  throw new Error("The selected module must default-export defineMitome({ agent, hosts }).");
}
const definition = loaded;

interface ErrorDetails {
  readonly _tag?: string;
  readonly message?: string;
  readonly cause?: Error | ErrorDetails;
}

// JSON.stringify throws on BigInt values and circular structures; a throwing
// formatter would mask the error being reported, so fall back to Bun's renderer.
const safeJson = (value: Error | ErrorDetails | null): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return Bun.inspect(value);
  }
};

const errorMessage = (error: Error | ErrorDetails): string => {
  const head =
    "_tag" in error && "message" in error
      ? `${String(error._tag)}: ${String(error.message)}`
      : error instanceof Error
        ? error.message
        : safeJson(error);
  const cause = error.cause;
  if (cause === undefined) return head;
  return `${head}\n  cause: ${cause !== null && cause instanceof Object ? errorMessage(cause) : safeJson(cause)}`;
};

const packageVersion = async (name: string): Promise<string> => {
  let current = dirname(definitionPath);
  while (true) {
    const packagePath = join(current, "node_modules", name, "package.json");
    try {
      const decoded = effect.Schema.decodeUnknownResult(
        effect.Schema.Struct({ version: effect.Schema.String }),
      )(JSON.parse(await readFile(packagePath, "utf8")));
      return effect.Result.isSuccess(decoded) ? decoded.success.version : "unknown";
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT")
        return "unknown";
    }
    const parent = dirname(current);
    if (parent === current) return "unknown";
    current = parent;
  }
};

try {
  const compiled = await effect.Effect.runPromise(core.compileAgentDefinition(definition.agent));
  const extensions = await Promise.all(
    compiled.extensions.map(async (extension) => ({
      name: extension.name ?? "(anonymous)",
      version: extension.name === undefined ? "unknown" : await packageVersion(extension.name),
    })),
  );
  await Bun.write(outputPath, JSON.stringify(extensions));
  process.exit(0);
} catch (error) {
  if (!(error instanceof Object)) {
    process.stderr.write(`${String(error)}\n`);
  } else {
    process.stderr.write(`${errorMessage(error)}\n`);
  }
  process.exit(1);
}
