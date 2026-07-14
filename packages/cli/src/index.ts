import { stat } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import corePackage from "@mitome/core/package.json" with { type: "json" };
// Bun embeds host.ts as source text at compile time; static analysis sees a module without a default export.
// @ts-expect-error
// oxlint-disable-next-line import/default
import definitionHost from "./host.ts" with { type: "text" };

type Package = {
  readonly version?: unknown;
};

const hostSource: string = definitionHost;

const definitionPath = async (args: ReadonlyArray<string>): Promise<string> => {
  let selected: string;
  if (args.length === 0) {
    const home = process.env.HOME;
    const configHome = process.env.XDG_CONFIG_HOME || (home ? join(home, ".config") : undefined);
    if (configHome === undefined) {
      throw new Error("Set XDG_CONFIG_HOME or HOME, or use --use <file>.");
    }
    selected = join(configHome, "mitome", "agent.ts");
  } else if (args.length === 2 && args[0] === "--use") {
    selected = args[1]!;
  } else {
    throw new Error("Usage: mitome [--use <file>]");
  }

  const path = resolve(selected);
  let file;
  try {
    file = await stat(path);
  } catch {
    throw new Error(
      args.length === 0
        ? `Definition not found at ${path}. Create it in XDG config or use --use <file>.`
        : `Definition not found at ${path}; check the --use path.`,
    );
  }
  if (file.isDirectory()) {
    throw new Error(
      `Definition path ${path} is a directory; --use requires a TypeScript entry file.`,
    );
  }
  if (extname(path) !== ".ts") {
    throw new Error(`Definition path ${path} must be a TypeScript entry file.`);
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

const checkRuntime = async (path: string): Promise<void> => {
  const core = await resolvePackage("@mitome/core", path);
  if (core === undefined) {
    throw new Error(
      `No @mitome/core is installed beside ${path}. Install @mitome/core@${corePackage.version} with the Definition dependencies.`,
    );
  }
  if (core.version !== corePackage.version) {
    throw new Error(
      `@mitome/core beside ${path} is ${String(core.version)}; install @mitome/core@${corePackage.version} with the Definition dependencies.`,
    );
  }
};

const runHost = async (path: string): Promise<void> => {
  const child = Bun.spawn([process.execPath, "--eval", hostSource, path], {
    env: { ...process.env, BUN_BE_BUN: "1" },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const forwardSigint = () => child.kill("SIGINT");
  process.once("SIGINT", forwardSigint);
  process.exitCode = await child.exited;
  process.off("SIGINT", forwardSigint);
};

const main = async (): Promise<void> => {
  const path = await definitionPath(process.argv.slice(2));
  await checkRuntime(path);
  await runHost(path);
};

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
