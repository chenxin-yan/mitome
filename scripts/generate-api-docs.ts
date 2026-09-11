#!/usr/bin/env bun
// Generates the API reference pages from TSDoc (ADR-0048). TypeDoc needs the TypeScript 6
// compiler API, which the repo's TypeScript 7 no longer ships, so it runs from the standalone
// tools/api-docs project whose own lockfile pins TypeScript 6.
import { fileURLToPath } from "node:url";

const toolDirectory = fileURLToPath(new URL("../tools/api-docs/", import.meta.url));

const run = async (command: ReadonlyArray<string>): Promise<void> => {
  const child = Bun.spawn([...command], {
    cwd: toolDirectory,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0)
    throw new Error(`${command.join(" ")} failed in ${toolDirectory}`);
};

await run(["bun", "install", "--frozen-lockfile"]);
await run(["bun", "run", "generate"]);
