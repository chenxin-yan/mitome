// Runs inside the embedded Bun runtime with the Agent Definition path as argv[1] and
// an output file as argv[2]. index.ts embeds this file as text like host.ts:
// Core is resolved beside the selected Agent Definition so credentialDescriptor sees
// the same module instance the Agent Definition's Model was created with. Without
// further arguments it writes the Model's credential descriptor (or null) as
// JSON to the output file; with an operation as argv[3] and the config
// directory as argv[4] it instead delegates the interactive login/logout to
// the descriptor's OAuth capability module.
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import type { Model } from "@mitome/core";

const definitionPath = process.argv[1]!;
const outputPath = process.argv[2]!;
const operation = process.argv[3];
const authConfigDirectory = process.argv[4];
const corePath = Bun.resolveSync("@mitome/core", dirname(definitionPath));
const core: typeof import("@mitome/core") = await import(pathToFileURL(corePath).href);
const loaded: unknown = (
  (await import(pathToFileURL(definitionPath).href)) as { readonly default: unknown }
).default;

const credential =
  typeof loaded === "object" && loaded !== null && "model" in loaded
    ? core.credentialDescriptor(loaded.model as Model)
    : undefined;

if (operation === undefined) {
  await writeFile(outputPath, JSON.stringify(credential ?? null));
} else {
  if (
    credential === undefined ||
    typeof credential === "string" ||
    authConfigDirectory === undefined
  ) {
    throw new Error("Agent Definition Model authentication is unsupported.");
  }
  const capability = (await import(credential.capability.module)) as {
    readonly authenticate?: (options: {
      readonly operation: string;
      readonly configDirectory: string;
      readonly input: () => Promise<string | undefined>;
      readonly output: (text: string) => void;
      readonly openBrowser?: false;
    }) => Promise<void>;
  };
  if (typeof capability.authenticate !== "function") {
    throw new Error("Agent Definition Model authentication is unsupported.");
  }
  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines = reader[Symbol.asyncIterator]();
  try {
    await capability.authenticate({
      operation,
      configDirectory: authConfigDirectory,
      input: async () => {
        const next = await lines.next();
        return next.done ? undefined : next.value;
      },
      output: (text) => process.stdout.write(text),
      ...(process.env.MITOME_NO_BROWSER === "1" ? { openBrowser: false } : {}),
    });
  } finally {
    // An open readline interface keeps the process alive on a TTY even after
    // authenticate resolves; close it so login/logout exit instead of hanging.
    reader.close();
  }
}
