// Runs inside the embedded Bun runtime with the Definition path as argv[1] and
// an output file as argv[2]. index.ts embeds this file as text like host.ts:
// Core is resolved beside the selected Definition so credentialDescriptor sees
// the same module instance the Definition's Model was created with. Writes the
// Model's credential descriptor (or null) as JSON to the output file.
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import type { Definition } from "@mitome/core";

const definitionPath = process.argv[1]!;
const outputPath = process.argv[2]!;
const corePath = Bun.resolveSync("@mitome/core", dirname(definitionPath));
const core: typeof import("@mitome/core") = await import(pathToFileURL(corePath).href);
const loaded: unknown = (
  (await import(pathToFileURL(definitionPath).href)) as { readonly default: unknown }
).default;

// Keep in sync with host.ts: both are standalone text-embedded scripts, so the
// guard cannot be shared without widening core's public API.
const isDefinition = (value: unknown): value is Definition => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Definition>;
  return (
    typeof candidate.instructions === "string" &&
    candidate.model !== undefined &&
    Array.isArray(candidate.plugins) &&
    candidate.plugins.every(
      (plugin) => typeof plugin === "object" && plugin !== null && typeof plugin.name === "string",
    )
  );
};

if (!isDefinition(loaded)) {
  throw new Error("Definition must default-export an Agent with instructions, model, and Plugins.");
}
await writeFile(outputPath, JSON.stringify(core.credentialDescriptor(loaded.model) ?? null));
