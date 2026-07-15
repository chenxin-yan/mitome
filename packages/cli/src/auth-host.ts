// Runs inside the embedded Bun runtime with the Definition path as argv[1] and
// an output file as argv[2]. index.ts embeds this file as text like host.ts:
// Core is resolved beside the selected Definition so credentialDescriptor sees
// the same module instance the Definition's Model was created with. Writes the
// Model's credential descriptor (or null) as JSON to the output file.
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import type { Model } from "@mitome/core";

const definitionPath = process.argv[1]!;
const outputPath = process.argv[2]!;
const corePath = Bun.resolveSync("@mitome/core", dirname(definitionPath));
const core: typeof import("@mitome/core") = await import(pathToFileURL(corePath).href);
const loaded: unknown = (
  (await import(pathToFileURL(definitionPath).href)) as { readonly default: unknown }
).default;

const credential =
  typeof loaded === "object" && loaded !== null && "model" in loaded
    ? core.credentialDescriptor(loaded.model as Model)
    : undefined;
await writeFile(outputPath, JSON.stringify(credential ?? null));
