import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect, Layer, Result, Schema } from "effect";
import { configDirectory, CredentialDescriptorSchema } from "@mitome/core";
import {
  ChildHost,
  type ExtensionListResult,
  type ProviderAuthentication,
} from "./child-host-service.js";
import { requireConfigDirectory } from "./config.js";
import { attempt, type ExitCode } from "./support.js";
// @ts-expect-error Bun embeds this as source text at compile time; TS sees a module without a default export.
// oxlint-disable-next-line import/default
import definitionHost from "./hosts/host.ts" with { type: "text" };
// @ts-expect-error Bun text import (see above).
// oxlint-disable-next-line import/default
import authHost from "./hosts/auth-host.ts" with { type: "text" };
// @ts-expect-error Bun text import (see above).
// oxlint-disable-next-line import/default
import extensionsHost from "./hosts/extensions-host.ts" with { type: "text" };
// @ts-expect-error Bun text import (see above).
// oxlint-disable-next-line import/default
import diagnostics from "./hosts/diagnostics.ts" with { type: "text" };

// The embedded programs run from `--eval` and cannot resolve a relative import of the
// CLI's own modules, so the shared diagnostics source takes the place of that import.
const diagnosticsSource: string = diagnostics;
const diagnosticsImport = 'import { errorMessage } from "./diagnostics.js";';
const embed = (source: string): string => source.replace(diagnosticsImport, diagnosticsSource);

const hostSource: string = embed(definitionHost);
const authHostSource: string = authHost;
const extensionsHostSource: string = embed(extensionsHost);
// A probe or auth program's lifetime is owned here, not by the program: it exits as soon
// as its module body finishes, so an Agent Definition that leaves an interval or server
// running at import cannot keep the child alive after its work is done.
const exitAfterBody = (source: string): string => `${source}\nprocess.exit(0);`;
// process.execPath is the compiled mitome binary; BUN_BE_BUN re-executes it as plain Bun.
const childEnv = { ...process.env, BUN_BE_BUN: "1" };

const configEnvFlag = (): string => {
  const directory = configDirectory();
  return directory === undefined ? "--no-env-file" : `--env-file=${join(directory, ".env")}`;
};

export const childHostLayer = Layer.succeed(ChildHost, {
  runHost: (path, message, mode) =>
    Effect.uninterruptible(attempt(() => runHost(path, message, mode))),
  serve: (path, port) =>
    Effect.uninterruptible(attempt(() => runEmbeddedHost(hostSource, path, String(port), "serve"))),
  install: (path) => Effect.uninterruptible(attempt(() => install(path))),
  removeDependency: (path, packageName) =>
    Effect.uninterruptible(attempt(() => removeDependency(path, packageName))),
  listExports: (packageName, directory) =>
    Effect.uninterruptible(attempt(() => listExports(packageName, directory))),
  inspectExtensions: (path) => Effect.uninterruptible(attempt(() => inspectExtensions(path))),
  inspectProviderAuthentication: (path) =>
    Effect.uninterruptible(attempt(() => inspectProviderAuthentication(path))),
  runOAuthAuth: (path, providerId, command) =>
    Effect.uninterruptible(attempt(() => runOAuthAuth(path, providerId, command))),
});

const ProviderAuthenticationSchema = Schema.Struct({
  id: Schema.String.check(Schema.isNonEmpty()),
  credential: CredentialDescriptorSchema,
});
const ProviderAuthenticationsFromJson = Schema.fromJsonString(
  Schema.Array(ProviderAuthenticationSchema),
);
const ExportNamesFromJson = Schema.fromJsonString(Schema.Array(Schema.String));
const ExtensionListFromJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      name: Schema.String,
      version: Schema.String,
    }),
  ),
);

// No SIGINT forwarding (unlike runHost): the installer is short-lived and
// terminal Ctrl-C reaches it through the process group.
const install = async (path: string): Promise<ExitCode> => {
  const child = Bun.spawn([process.execPath, "install"], {
    cwd: dirname(path),
    env: childEnv,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
};

const removeDependency = async (path: string, packageName: string): Promise<ExitCode> => {
  const child = Bun.spawn([process.execPath, "remove", packageName], {
    cwd: dirname(path),
    env: childEnv,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
};

// Loads the package in a disposable child so import-time side effects (process.exit,
// long-running work, never-settling top-level await) cannot terminate or hang the CLI.
const exportProbeSource = [
  "const loaded = await import(process.argv[1]);",
  'const names = Object.entries(loaded).filter(([, value]) => typeof value === "function").map(([name]) => name);',
  "await Bun.write(process.argv[2], JSON.stringify(names));",
].join("\n");

interface JsonHostOptions {
  readonly envFlag: string;
  readonly stderr: "ignore" | "inherit";
  readonly timeout: number;
}

// Runs a disposable inspection program that writes its JSON result to the trailing argv
// path; `timeout` bounds a body that never finishes.
const runJsonHost = async (
  prefix: string,
  source: string,
  arguments_: ReadonlyArray<string>,
  options: JsonHostOptions,
): Promise<{ readonly exitCode: ExitCode; readonly output: string }> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const output = join(directory, "output.json");
  try {
    const child = Bun.spawn(
      [process.execPath, options.envFlag, "--eval", exitAfterBody(source), ...arguments_, output],
      { env: childEnv, stdout: "ignore", stderr: options.stderr, timeout: options.timeout },
    );
    const exitCode = await child.exited;
    return {
      exitCode,
      output: exitCode === 0 ? await readFile(output, "utf8") : "",
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const listExports = async (
  packageName: string,
  directory: string,
): Promise<ReadonlyArray<string>> => {
  const moduleUrl = pathToFileURL(Bun.resolveSync(packageName, directory)).href;
  // The names travel via file rather than stdout: importing the package may print.
  const result = await runJsonHost("mitome-exports-", exportProbeSource, [moduleUrl], {
    envFlag: "--no-env-file",
    stderr: "ignore",
    timeout: 5000,
  });
  if (result.exitCode !== 0) throw new Error(`Could not inspect ${packageName} exports.`);
  return Schema.decodeSync(ExportNamesFromJson)(result.output);
};

const inspectExtensions = async (path: string): Promise<ExtensionListResult> => {
  const result = await runJsonHost("mitome-extensions-", extensionsHostSource, [path], {
    envFlag: configEnvFlag(),
    stderr: "inherit",
    // Importing and compiling an Agent Definition may take substantially longer than an export probe.
    timeout: 30_000,
  });
  if (result.exitCode !== 0) return { exitCode: result.exitCode, extensions: [] };
  return {
    exitCode: result.exitCode,
    extensions: Schema.decodeSync(ExtensionListFromJson)(result.output),
  };
};

const runHost = (
  path: string,
  message: string | undefined,
  mode: "auto" | "print",
): Promise<ExitCode> => runEmbeddedHost(hostSource, path, message, mode);

export const runEmbeddedHost = async (
  source: string,
  path: string,
  message: string | undefined,
  mode: "auto" | "print" | "serve",
): Promise<ExitCode> => {
  // Both flags suppress Bun's automatic cwd .env autoload in the child; the
  // config .env is loaded explicitly when a config directory exists.
  // The message argument is omitted entirely when absent so the child can tell
  // "no message given" apart from an explicitly empty message; serve mode
  // carries the port in its place.
  const arguments_ = [process.execPath, configEnvFlag(), "--eval", source, path, mode];
  if (message !== undefined) arguments_.push(message);
  const child = Bun.spawn(arguments_, {
    env: childEnv,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  // SIGINT reaches the child through the process group as well; SIGTERM (a
  // service manager stopping `mitome serve`) only through this forwarding.
  const forwardSigint = () => child.kill("SIGINT");
  const forwardSigterm = () => child.kill("SIGTERM");
  process.once("SIGINT", forwardSigint);
  process.once("SIGTERM", forwardSigterm);
  try {
    return await child.exited;
  } finally {
    process.off("SIGINT", forwardSigint);
    process.off("SIGTERM", forwardSigterm);
  }
};

const inspectProviderAuthentication = async (
  path: string,
): Promise<ReadonlyArray<ProviderAuthentication>> => {
  // The descriptor travels via file rather than stdout: importing the Agent Definition
  // may print, and stdout stays ignored so nothing leaks into the message flow.
  const result = await runJsonHost("mitome-auth-", authHostSource, [path], {
    envFlag: "--no-env-file",
    stderr: "inherit",
    timeout: 30_000,
  });
  if (result.exitCode !== 0) throw new Error("Could not inspect Agent Definition authentication.");
  const authentication = Schema.decodeResult(ProviderAuthenticationsFromJson, {
    onExcessProperty: "error",
  })(result.output);
  if (Result.isFailure(authentication)) {
    throw new Error("Agent Definition returned invalid Provider authentication metadata.");
  }
  return authentication.success;
};

const runOAuthAuth = async (
  path: string,
  providerId: string,
  command: "login" | "logout",
): Promise<void> => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--eval",
      exitAfterBody(authHostSource),
      path,
      "",
      command,
      requireConfigDirectory(),
      providerId,
    ],
    {
      env: childEnv,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if ((await child.exited) !== 0) throw new Error("Provider authentication failed.");
};
