// Runs inside the embedded Bun runtime. Core is resolved beside the selected
// Agent Definition so Provider WeakMap identity matches the author's Core copy.
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import type { AuthCapability, AnyProvider } from "@mitome/core";

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

const providers =
  typeof loaded === "object" &&
  loaded !== null &&
  "providers" in loaded &&
  Array.isArray(loaded.providers)
    ? (loaded.providers as ReadonlyArray<AnyProvider>)
    : [];
const authentication = providers.flatMap((provider) => {
  const credential = core.credentialDescriptor(provider);
  return credential === undefined ? [] : [{ id: provider.id, credential }];
});

if (operation === undefined) {
  await writeFile(outputPath, JSON.stringify(authentication));
} else {
  const selected = authentication.find(({ id }) => id === selectedProviderId);
  if (
    selected === undefined ||
    typeof selected.credential === "string" ||
    authConfigDirectory === undefined ||
    (operation !== "login" && operation !== "logout")
  ) {
    throw new Error("Selected Provider does not support OAuth authentication.");
  }
  const capability = (await import(
    selected.credential.capability.module
  )) as Partial<AuthCapability>;
  if (typeof capability.authenticate !== "function") {
    throw new Error("Selected Provider does not support OAuth authentication.");
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
    reader.close();
  }
}
