// Runs inside the embedded Bun runtime. Core is resolved beside the selected
// Agent Definition so Provider WeakMap identity matches the author's Core copy.
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import type { AuthCapability, MitomeDefinition } from "@mitome/core";

const definitionPath = process.argv[1]!;
const outputPath = process.argv[2]!;
const operation = process.argv[3];
const authConfigDirectory = process.argv[4];
const selectedProviderId = process.argv[5];
const corePath = Bun.resolveSync("@mitome/core", dirname(definitionPath));
const core: typeof import("@mitome/core") = await import(pathToFileURL(corePath).href);
const loaded: unknown = (
  (await import(pathToFileURL(definitionPath).href)) as { readonly default: unknown }
).default;
const providers = (loaded as Partial<MitomeDefinition> | undefined)?.agent?.providers;
if (!Array.isArray(providers)) {
  throw new Error("The selected module must default-export defineMitome({ agent, hosts }).");
}
const authentication = providers.flatMap((provider) => {
  const credential = core.credentialDescriptor(provider);
  return credential === undefined ? [] : [{ id: provider.id, credential }];
});

if (operation === undefined) {
  await writeFile(outputPath, JSON.stringify(authentication));
} else {
  if (
    authConfigDirectory === undefined ||
    selectedProviderId === undefined ||
    (operation !== "login" && operation !== "logout")
  ) {
    throw new Error("Invalid Provider authentication host operation or configuration.");
  }
  const selected = authentication.find(({ id }) => id === selectedProviderId);
  if (selected === undefined || typeof selected.credential === "string") {
    throw new Error(
      `Provider \`${selectedProviderId}\` was not found or does not declare OAuth authentication.`,
    );
  }
  const capability = (await import(
    selected.credential.capability.module
  )) as Partial<AuthCapability>;
  if (typeof capability.authenticate !== "function") {
    throw new Error(
      `OAuth capability for Provider \`${selectedProviderId}\` does not export \`authenticate\`.`,
    );
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
      openBrowser: process.env.MITOME_NO_BROWSER === "1" ? false : undefined,
    });
  } finally {
    reader.close();
  }
}
