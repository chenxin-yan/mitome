import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, extname, join, resolve } from "node:path";
import { resolveConfigDirectory, type CredentialDescriptor } from "@mitome/core";
import corePackage from "@mitome/core/package.json" with { type: "json" };
// Bun embeds host.ts as source text at compile time; static analysis sees a module without a default export.
// @ts-expect-error
// oxlint-disable-next-line import/default
import definitionHost from "./host.ts" with { type: "text" };
// @ts-expect-error
// oxlint-disable-next-line import/default
import authHost from "./auth-host.ts" with { type: "text" };

type Package = {
  readonly version?: unknown;
};

const hostSource: string = definitionHost;
const authHostSource: string = authHost;

// Validates untrusted JSON crossing the auth-host process boundary.
const isCredentialDescriptor = (value: unknown): value is CredentialDescriptor =>
  typeof value === "string"
    ? /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
    : typeof value === "object" &&
      value !== null &&
      "capability" in value &&
      typeof value.capability === "object" &&
      value.capability !== null &&
      "module" in value.capability &&
      typeof value.capability.module === "string";

const configDirectoryMessage = "Set XDG_CONFIG_HOME, APPDATA (on Windows), or HOME.";

const configDirectory = (): string | undefined =>
  resolveConfigDirectory(process.env, process.platform);

// Bun needs an --env-file path that exists on every platform (Windows has no
// /dev/null); one empty process-lifetime file keeps auth/no-config children
// from autoloading a cwd .env.
let emptyEnv: string | undefined;
const emptyEnvFile = async (): Promise<string> => {
  if (emptyEnv === undefined) {
    emptyEnv = join(await mkdtemp(join(tmpdir(), "mitome-env-")), "empty.env");
    await writeFile(emptyEnv, "");
  }
  return emptyEnv;
};

const isEnoent = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

const configEnvName = (line: string): string | undefined =>
  /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1];

const readConfigEnv = async (path: string): Promise<string> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    // Missing config .env is normal; other filesystem errors must remain visible.
    if (isEnoent(error)) return "";
    throw error;
  }
};

const requireConfigDirectory = (): string => {
  const directory = configDirectory();
  if (directory === undefined) throw new Error(configDirectoryMessage);
  return directory;
};

const writeConfigEnv = async (contents: string): Promise<void> => {
  const directory = requireConfigDirectory();
  await mkdir(directory, { recursive: true });
  const temporary = await mkdtemp(join(directory, ".env-"));
  const file = join(temporary, "value");
  try {
    await writeFile(file, contents, { mode: 0o600 });
    await rename(file, join(directory, ".env"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
};

const configEnvLines = async (): Promise<Array<string>> => {
  const contents = await readConfigEnv(join(requireConfigDirectory(), ".env"));
  const lines = contents === "" ? [] : contents.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

const updateConfigEnv = async (name: string, value: string): Promise<void> => {
  // Bun's --env-file parser mangles these on read-back: # truncates as a comment,
  // $ expands (even quoted), quotes strip, and edge whitespace trims. Reject loudly
  // instead of storing a value that would round-trip corrupted; process env is the
  // documented escape hatch for such secrets.
  if (/[\r\n#$'"]/.test(value) || value !== value.trim()) {
    throw new Error(
      `${name} contains characters Bun cannot store in .env ('#', '$', quotes, edge whitespace, or newlines); set the environment variable directly instead.`,
    );
  }
  const lines = await configEnvLines();
  await writeConfigEnv(
    [...lines.filter((line) => configEnvName(line) !== name), `${name}=${value}`].join("\n") + "\n",
  );
};

const removeConfigEnv = async (name: string): Promise<void> => {
  const lines = await configEnvLines();
  const kept = lines.filter((line) => configEnvName(line) !== name);
  if (kept.length === lines.length) return;
  await writeConfigEnv(kept.length === 0 ? "" : kept.join("\n") + "\n");
};

// Same readline shape host.ts uses; a lone \r (raw-mode Enter) emits a line
// immediately, so the masked prompt works without a hand-rolled reader.
const makeInput = (): (() => Promise<string | undefined>) => {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })[
    Symbol.asyncIterator
  ]();
  return async () => {
    const next = await lines.next();
    return next.done ? undefined : next.value;
  };
};

const prompt = async (
  message: string,
  input: () => Promise<string | undefined>,
): Promise<string> => {
  process.stdout.write(message);
  const value = await input();
  if (value === undefined) throw new Error("Input closed.");
  return value;
};

const maskedPrompt = async (
  message: string,
  input: () => Promise<string | undefined>,
): Promise<string> => {
  const stdin = process.stdin;
  const raw = stdin.isTTY;
  if (raw) stdin.setRawMode(true);
  try {
    const value = await prompt(message, input);
    // ponytail: raw mode disables terminal SIGINT, and the line reader only
    // surfaces ^C once Enter flushes the line; per-byte abort needs a raw reader.
    if (value.includes("\u0003")) throw new Error("Credential input cancelled.");
    let secret = "";
    for (const character of value) {
      secret =
        character === "\b" || character === "\u007f" ? secret.slice(0, -1) : secret + character;
    }
    if (secret === "") throw new Error("Credential value is required.");
    return secret;
  } finally {
    if (raw) {
      stdin.setRawMode(false);
      process.stdout.write("\n");
    }
  }
};

const definitionPath = async (args: ReadonlyArray<string>): Promise<string> => {
  let selected: string;
  if (args.length === 0) {
    const directory = configDirectory();
    if (directory === undefined) {
      throw new Error(`${configDirectoryMessage} Or use --use <file>.`);
    }
    selected = join(directory, "agent.ts");
  } else if (args.length === 2 && args[0] === "--use") {
    selected = args[1]!;
  } else {
    throw new Error("Usage: mitome [install|init|auth <login|logout>] [--use <file>]");
  }

  const path = resolve(selected);
  let file;
  try {
    file = await stat(path);
  } catch {
    throw new Error(
      args.length === 0
        ? "No Definition found; run mitome init first or use --use <file>."
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
      `No @mitome/core is installed beside ${path}. Install @mitome/core@${corePackage.version} with the Definition dependencies (run \`mitome install\`).`,
    );
  }
  if (core.version !== corePackage.version) {
    throw new Error(
      `@mitome/core beside ${path} is ${String(core.version)}; install @mitome/core@${corePackage.version} with the Definition dependencies (run \`mitome install\`).`,
    );
  }
};

// No SIGINT forwarding (unlike runHost): the installer is short-lived and
// terminal Ctrl-C reaches it through the process group.
const install = async (path: string): Promise<void> => {
  const child = Bun.spawn([process.execPath, "install"], {
    cwd: dirname(path),
    env: { ...process.env, BUN_BE_BUN: "1" },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = await child.exited;
};

const runHost = async (path: string): Promise<void> => {
  const directory = configDirectory();
  // Always pass --env-file: its presence suppresses Bun's automatic cwd .env
  // autoload in the child, and Bun tolerates a missing file silently.
  const envPath = directory === undefined ? await emptyEnvFile() : join(directory, ".env");
  const child = Bun.spawn([process.execPath, `--env-file=${envPath}`, "--eval", hostSource, path], {
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

const inspectCredential = async (path: string): Promise<CredentialDescriptor> => {
  const directory = await mkdtemp(join(tmpdir(), "mitome-auth-"));
  // The descriptor travels via file rather than stdout: importing the Definition
  // may print, and stdout stays ignored so nothing leaks into the prompt flow.
  const output = join(directory, "credential.json");
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        `--env-file=${await emptyEnvFile()}`,
        "--eval",
        authHostSource,
        path,
        output,
      ],
      {
        env: { ...process.env, BUN_BE_BUN: "1" },
        stdout: "ignore",
        stderr: "inherit",
      },
    );
    if ((await child.exited) !== 0) throw new Error("Could not inspect Definition authentication.");
    const credential: unknown = JSON.parse(await readFile(output, "utf8"));
    if (!isCredentialDescriptor(credential))
      throw new Error("Definition Model does not support CLI authentication.");
    return credential;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const runOAuthAuth = async (path: string, command: "login" | "logout"): Promise<void> => {
  const child = Bun.spawn(
    [
      process.execPath,
      `--env-file=${await emptyEnvFile()}`,
      "--eval",
      authHostSource,
      path,
      "",
      command,
      requireConfigDirectory(),
    ],
    {
      env: { ...process.env, BUN_BE_BUN: "1" },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if ((await child.exited) !== 0) throw new Error("Provider authentication failed.");
};

const init = async (): Promise<void> => {
  const directory = requireConfigDirectory();
  const path = join(directory, "agent.ts");
  for (const file of [path, join(directory, "package.json")]) {
    const existing = await stat(file).catch((error: unknown) => {
      if (!isEnoent(error)) throw error;
      return undefined;
    });
    if (existing !== undefined) {
      throw new Error(
        `${file} already exists; remove it, or run mitome install and mitome auth login.`,
      );
    }
  }

  const input = makeInput();
  const model = (await prompt("OpenAI model identifier: ", input)).trim();
  if (model === "") throw new Error("OpenAI model identifier is required.");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path,
    `import { defineAgent } from "@mitome/sdk";\nimport { env, openai } from "@mitome/openai";\n\nexport default defineAgent({\n  instructions: "You are a helpful Agent.",\n  model: openai(${JSON.stringify(model)}, env("OPENAI_API_KEY")),\n  plugins: [],\n});\n`,
  );
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "mitome-agent",
        private: true,
        type: "module",
        dependencies: {
          "@mitome/core": corePackage.version,
          "@mitome/openai": corePackage.version,
          "@mitome/sdk": corePackage.version,
        },
      },
      null,
      2,
    )}\n`,
  );
  await install(path);
  if (process.exitCode !== 0) return;
  await updateConfigEnv("OPENAI_API_KEY", await maskedPrompt("OpenAI API key: ", input));
};

const auth = async (command: string | undefined, args: ReadonlyArray<string>): Promise<void> => {
  if (command !== "login" && command !== "logout") {
    throw new Error("Usage: mitome auth <login|logout> [--use <file>]");
  }
  const path = await definitionPath(args);
  await checkRuntime(path);
  const credential = await inspectCredential(path);
  if (typeof credential !== "string") {
    await runOAuthAuth(path, command);
    return;
  }
  if (command === "logout") {
    await removeConfigEnv(credential);
    return;
  }
  const input = makeInput();
  await updateConfigEnv(credential, await maskedPrompt(`${credential}: `, input));
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  if (args[0] === "install") {
    await install(await definitionPath(args.slice(1)));
    return;
  }
  if (args[0] === "init") {
    if (args.length !== 1) throw new Error("Usage: mitome init");
    await init();
    return;
  }
  if (args[0] === "auth") {
    await auth(args[1], args.slice(2));
    return;
  }
  const path = await definitionPath(args);
  await checkRuntime(path);
  await runHost(path);
};

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
