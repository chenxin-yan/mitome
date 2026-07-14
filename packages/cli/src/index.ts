import { stat } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import packageJson from "../package.json" with { type: "json" };

type Package = {
  readonly version?: unknown;
};

const definitionHost = String.raw`
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const definitionPath = process.argv[1];
const corePath = Bun.resolveSync("@mitome/core", dirname(definitionPath));
const effectPath = Bun.resolveSync("effect", dirname(corePath));
const core = await import(pathToFileURL(corePath).href);
const effect = await import(pathToFileURL(effectPath).href);
const loaded = (await import(pathToFileURL(definitionPath).href)).default;

const isDefinition = (value) => {
  if (typeof value !== "object" || value === null) return false;
  return (
    typeof value.instructions === "string" &&
    value.model !== undefined &&
    Array.isArray(value.plugins) &&
    value.plugins.every((plugin) =>
      typeof plugin === "object" && plugin !== null && typeof plugin.name === "string",
    )
  );
};

const render = (event) => {
  switch (event.type) {
    case "model-output":
      process.stdout.write(event.text);
      break;
    case "tool-call":
      process.stdout.write("\n[tool " + event.name + "]\n");
      break;
    case "tool-result":
      process.stdout.write(
        "\n[tool " + event.name + " " + (event.isFailure ? "failed" : "completed") + "]\n",
      );
      break;
    case "response-complete":
      process.stdout.write("\n");
      break;
  }
};

const errorMessage = (error) => {
  if (typeof error === "object" && error !== null && "_tag" in error && "message" in error) {
    return String(error._tag) + ": " + String(error.message);
  }
  return error instanceof Error ? error.message : String(error);
};

const serve = async (session, state) => {
  for await (const text of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const turn = effect.Effect.runFork(
      effect.Stream.runForEach(session.prompt(text), (event) =>
        effect.Effect.sync(() => render(event)),
      ),
    );
    state.active = turn;
    const exit = await effect.Effect.runPromiseExit(effect.Fiber.join(turn));
    state.active = undefined;
    if (effect.Exit.isFailure(exit)) {
      if (state.interrupted) return;
      process.stderr.write(errorMessage(effect.Cause.squash(exit.cause)) + "\n");
      process.exitCode = 1;
      return;
    }
  }
};

if (!isDefinition(loaded)) {
  throw new Error("Definition must default-export an Agent with instructions, model, and Plugins.");
}
const state = { active: undefined, interrupted: false };
const root = effect.Effect.runFork(
  effect.Effect.scoped(
    effect.Effect.gen(function* () {
      const session = yield* core.createSession(loaded);
      yield* effect.Effect.promise(() => serve(session, state));
    }),
  ),
);
const interrupt = () => {
  if (state.interrupted) return;
  state.interrupted = true;
  const forceExit = setTimeout(() => process.exit(124), 1_000);
  void (async () => {
    if (state.active !== undefined) {
      await effect.Effect.runPromise(effect.Fiber.interrupt(state.active));
    }
    await effect.Effect.runPromise(effect.Fiber.interrupt(root));
    clearTimeout(forceExit);
    process.exit(130);
  })();
};
process.on("SIGINT", interrupt);
const exit = await effect.Effect.runPromiseExit(effect.Fiber.join(root));
process.off("SIGINT", interrupt);
if (effect.Exit.isFailure(exit) && !state.interrupted) {
  process.stderr.write(errorMessage(effect.Cause.squash(exit.cause)) + "\n");
  process.exitCode = 1;
}
`;

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
      `Definition not found at ${path}. Create it in XDG config or use --use <file>.`,
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
    } catch {
      // Expected while walking package parents: try the next node_modules directory.
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
      `No @mitome/core is installed beside ${path}. install @mitome/core@${packageJson.version} with the Definition dependencies.`,
    );
  }
  if (core.version !== packageJson.version) {
    throw new Error(
      `@mitome/core beside ${path} is ${String(core.version)}; install @mitome/core@${packageJson.version} with the Definition dependencies.`,
    );
  }
};

const runHost = async (path: string): Promise<void> => {
  const child = Bun.spawn([process.execPath, "--eval", definitionHost, path], {
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
