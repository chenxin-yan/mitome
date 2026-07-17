import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { resolveConfigDirectory, type CredentialDescriptor } from "@mitome/core";
import { Console, Effect, Layer, Option, Redacted, Runtime, Terminal } from "effect";
import { Argument, CliError, CliOutput, Command, Flag, Prompt } from "effect/unstable/cli";
import corePackage from "@mitome/core/package.json" with { type: "json" };
import cliPackage from "../package.json" with { type: "json" };
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

class ReportedError extends Error {
  override readonly [Runtime.errorReported] = false;
}

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

const definitionPath = async (use: Option.Option<string>): Promise<string> => {
  const selected = Option.getOrUndefined(use);
  if (selected === undefined && configDirectory() === undefined) {
    throw new Error(`${configDirectoryMessage} Or use --use <file>.`);
  }
  const path = resolve(selected ?? join(configDirectory()!, "agent.ts"));
  let file;
  try {
    file = await stat(path);
  } catch {
    throw new Error(
      selected === undefined
        ? "No Agent Definition found; run mitome init first or use --use <file>."
        : `Agent Definition not found at ${path}; check the --use path.`,
    );
  }
  if (file.isDirectory()) {
    throw new Error(
      `Agent Definition path ${path} is a directory; --use requires a TypeScript entry file.`,
    );
  }
  if (extname(path) !== ".ts") {
    throw new Error(`Agent Definition path ${path} must be a TypeScript entry file.`);
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
      `No @mitome/core is installed beside ${path}. Install @mitome/core@${corePackage.version} with the Agent Definition dependencies (run \`mitome install\`).`,
    );
  }
  if (core.version !== corePackage.version) {
    throw new Error(
      `@mitome/core beside ${path} is ${String(core.version)}; install @mitome/core@${corePackage.version} with the Agent Definition dependencies (run \`mitome install\`).`,
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

const runHost = async (path: string, prompt: string): Promise<void> => {
  const directory = configDirectory();
  // Always pass --env-file: its presence suppresses Bun's automatic cwd .env
  // autoload in the child, and Bun tolerates a missing file silently.
  const envPath = directory === undefined ? await emptyEnvFile() : join(directory, ".env");
  const child = Bun.spawn(
    [process.execPath, `--env-file=${envPath}`, "--eval", hostSource, path, prompt],
    {
      env: { ...process.env, BUN_BE_BUN: "1" },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const forwardSigint = () => child.kill("SIGINT");
  process.once("SIGINT", forwardSigint);
  try {
    process.exitCode = await child.exited;
  } finally {
    process.off("SIGINT", forwardSigint);
  }
};

const inspectCredential = async (path: string): Promise<CredentialDescriptor> => {
  const directory = await mkdtemp(join(tmpdir(), "mitome-auth-"));
  // The descriptor travels via file rather than stdout: importing the Agent Definition
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
    if ((await child.exited) !== 0)
      throw new Error("Could not inspect Agent Definition authentication.");
    const credential: unknown = JSON.parse(await readFile(output, "utf8"));
    if (!isCredentialDescriptor(credential))
      throw new Error("Agent Definition Model does not support CLI authentication.");
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

const initializationPath = async (): Promise<string> => {
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
  return path;
};

const initialize = async (path: string, model: string): Promise<void> => {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path,
    `import { defineAgent } from "@mitome/sdk";\nimport { env, openai } from "@mitome/providers/openai";\n\nexport default defineAgent({\n  instructions: "You are a helpful Agent.",\n  model: openai(${JSON.stringify(model)}, env("OPENAI_API_KEY")),\n  plugins: [],\n});\n`,
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
          "@mitome/providers": corePackage.version,
          "@mitome/sdk": corePackage.version,
        },
      },
      null,
      2,
    )}\n`,
  );
  await install(path);
};

const attempt = <A>(promise: () => Promise<A>) =>
  Effect.tryPromise({
    try: promise,
    catch: (error) => new ReportedError(error instanceof Error ? error.message : String(error)),
  }).pipe(Effect.tapError((error) => Console.error(error.message)));

const waitForChild = <A>(promise: () => Promise<A>) => Effect.uninterruptible(attempt(promise));

const fail = (message: string) =>
  Console.error(message).pipe(Effect.andThen(Effect.fail(new ReportedError(message))));

// Prompt.run hangs when beta.98's Bun terminal sees stdin EOF. Defer the
// interruption one tick so a final buffered line can still submit first.
const runNativePrompt = <A>(prompt: Prompt.Prompt<A>) =>
  Prompt.run(prompt).pipe(
    Effect.raceFirst(
      Effect.callback<never, Terminal.QuitError>((resume) => {
        let pending: ReturnType<typeof setImmediate> | undefined;
        const quit = () => resume(Effect.fail(new Terminal.QuitError({})));
        const onEnd = () => {
          pending = setImmediate(quit);
        };
        if (process.stdin.readableEnded) onEnd();
        else process.stdin.once("end", onEnd);
        return Effect.sync(() => {
          process.stdin.off("end", onEnd);
          if (pending !== undefined) clearImmediate(pending);
        });
      }),
    ),
  );

const useFlag = Flag.string("use").pipe(
  Flag.withDescription("Path to an Agent Definition TypeScript entry file"),
  Flag.optional,
);

// Effect beta.98 ignores unconsumed positionals, so consume them all and
// validate cardinality inside the native argument parser.
const noArguments = Argument.string("argument").pipe(
  Argument.variadic(),
  Argument.mapEffect((arguments_) =>
    arguments_.length === 0
      ? Effect.void
      : Effect.fail(
          new CliError.InvalidValue({
            option: "argument",
            value: arguments_[0]!,
            expected: "no additional arguments",
            kind: "argument",
          }),
        ),
  ),
);

const missingUseFlag = Flag.boolean("__mitome-missing-use").pipe(
  Flag.withHidden,
  Flag.mapEffect((missing) =>
    missing ? Effect.fail(new CliError.MissingOption({ option: "use" })) : Effect.void,
  ),
);

const promptArgument = Argument.string("prompt").pipe(
  Argument.variadic(),
  Argument.mapEffect((prompts) =>
    prompts.length === 1
      ? Effect.succeed(prompts[0]!)
      : prompts.length === 0
        ? Effect.fail(new CliError.MissingArgument({ argument: "prompt" }))
        : Effect.fail(
            new CliError.InvalidValue({
              option: "prompt",
              value: prompts[1]!,
              expected: "exactly one prompt",
              kind: "argument",
            }),
          ),
  ),
  Argument.withDescription("Prompt to send to the Agent"),
);

const runPrompt = ({
  prompt,
  use,
}: {
  readonly prompt: string;
  readonly use: Option.Option<string>;
}) =>
  Effect.gen(function* () {
    const path = yield* attempt(() => definitionPath(use));
    yield* attempt(() => checkRuntime(path));
    yield* waitForChild(() => runHost(path, prompt));
  });

const runInstall = ({ use }: { readonly use: Option.Option<string> }) =>
  Effect.gen(function* () {
    const path = yield* attempt(() => definitionPath(use));
    yield* waitForChild(() => install(path));
  });

const runInit = Effect.gen(function* () {
  const path = yield* attempt(initializationPath);
  const model = (yield* runNativePrompt(
    Prompt.text({ message: "OpenAI model identifier" }),
  )).trim();
  if (model === "") return yield* fail("OpenAI model identifier is required.");
  yield* waitForChild(() => initialize(path, model));
  if (process.exitCode !== 0) return;
  const credential = Redacted.value(
    yield* runNativePrompt(Prompt.password({ message: "OpenAI API key" })),
  );
  if (credential === "") return yield* fail("Credential value is required.");
  yield* attempt(() => updateConfigEnv("OPENAI_API_KEY", credential));
});

const runAuth = (command: "login" | "logout", use: Option.Option<string>) =>
  Effect.gen(function* () {
    const path = yield* attempt(() => definitionPath(use));
    yield* attempt(() => checkRuntime(path));
    const credential = yield* waitForChild(() => inspectCredential(path));
    if (typeof credential !== "string") {
      yield* waitForChild(() => runOAuthAuth(path, command));
      return;
    }
    if (command === "logout") {
      yield* attempt(() => removeConfigEnv(credential));
      return;
    }
    const value = Redacted.value(yield* runNativePrompt(Prompt.password({ message: credential })));
    if (value === "") return yield* fail("Credential value is required.");
    yield* attempt(() => updateConfigEnv(credential, value));
  });

const definitionCommandConfig = {
  arguments: noArguments,
  missingUse: missingUseFlag,
  use: useFlag,
};

const installCommand = Command.make("install", definitionCommandConfig, runInstall).pipe(
  Command.withDescription("Install Agent Definition dependencies"),
);
const initCommand = Command.make("init", { arguments: noArguments }, () => runInit).pipe(
  Command.withDescription("Create a default Agent Definition"),
);
const loginCommand = Command.make("login", definitionCommandConfig, ({ use }) =>
  runAuth("login", use),
);
const logoutCommand = Command.make("logout", definitionCommandConfig, ({ use }) =>
  runAuth("logout", use),
);
const authCommand = Command.make("auth", {}, () =>
  fail("Usage: mitome auth <login|logout> [--use <file>]"),
).pipe(
  Command.withDescription("Manage Agent Definition authentication"),
  Command.withSubcommands([loginCommand, logoutCommand]),
);

export const command = Command.make(
  "mitome",
  {
    missingUse: missingUseFlag,
    prompt: promptArgument,
    use: useFlag,
  },
  runPrompt,
).pipe(
  Command.withDescription("Run an Agent Definition"),
  Command.withSubcommands([installCommand, initCommand, authCommand]),
);

const nativeRunCli = Command.runWith(command, { version: cliPackage.version });
const normalizeMissingUseValue = (args: ReadonlyArray<string>): ReadonlyArray<string> => {
  const terminator = args.indexOf("--");
  const optionCount = terminator === -1 ? args.length : terminator;
  const missing = args.findIndex(
    (arg, index) =>
      index < optionCount &&
      arg === "--use" &&
      (args[index + 1] === undefined || args[index + 1]!.startsWith("-")),
  );
  return missing === -1
    ? args
    : args.map((arg, index) => (index === missing ? "--__mitome-missing-use" : arg));
};

export const runCli = (args: ReadonlyArray<string>) => nativeRunCli(normalizeMissingUseValue(args));

if (import.meta.main) {
  const services = Layer.merge(BunServices.layer, CliOutput.layer(CliOutput.defaultFormatter()));
  const args = process.argv.slice(2);
  const normalizedArgs = normalizeMissingUseValue(args);
  // beta.98 drops a trailing string flag instead of reporting its missing value.
  const program = (
    normalizedArgs === args
      ? Command.run(command, { version: cliPackage.version })
      : nativeRunCli(normalizedArgs)
  ).pipe(Effect.provide(services));
  BunRuntime.runMain(program);
}
