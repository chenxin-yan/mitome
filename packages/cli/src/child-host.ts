import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Context, Effect, Layer, Result, Schema } from "effect";
import {
  configDirectory,
  CredentialDescriptorSchema,
  type CredentialDescriptor,
} from "@mitome/core";
import { requireConfigDirectory } from "./config.js";
import { attempt, type CliError, type ExitCode } from "./support.js";
// @ts-expect-error Bun embeds this as source text at compile time; TS sees a module without a default export.
// oxlint-disable-next-line import/default
import definitionHost from "./hosts/host.ts" with { type: "text" };
// @ts-expect-error Bun text import (see above).
// oxlint-disable-next-line import/default
import authHost from "./hosts/auth-host.ts" with { type: "text" };
// @ts-expect-error Bun text import (see above).
// oxlint-disable-next-line import/default
import extensionsHost from "./hosts/extensions-host.ts" with { type: "text" };

const hostSource: string = definitionHost;
const authHostSource: string = authHost;
const extensionsHostSource: string = extensionsHost;
// process.execPath is the compiled mitome binary; BUN_BE_BUN re-executes it as plain Bun.
const childEnv = { ...process.env, BUN_BE_BUN: "1" };

export interface ProviderAuthentication {
  readonly id: string;
  readonly credential: CredentialDescriptor;
}

export interface ExtensionListItem {
  readonly name: string;
  readonly version: string;
  readonly direct: boolean;
  readonly dependents: ReadonlyArray<string>;
}

export interface ExtensionListResult {
  readonly exitCode: ExitCode;
  readonly extensions: ReadonlyArray<ExtensionListItem>;
}

export class ChildHost extends Context.Service<
  ChildHost,
  {
    readonly runHost: (path: string, prompt: string) => Effect.Effect<ExitCode, CliError>;
    readonly install: (path: string) => Effect.Effect<ExitCode, CliError>;
    readonly removeDependency: (
      path: string,
      packageName: string,
    ) => Effect.Effect<ExitCode, CliError>;
    readonly listExports: (
      packageName: string,
      directory: string,
    ) => Effect.Effect<ReadonlyArray<string>, CliError>;
    readonly inspectExtensions: (path: string) => Effect.Effect<ExtensionListResult, CliError>;
    readonly inspectProviderAuthentication: (
      path: string,
    ) => Effect.Effect<ReadonlyArray<ProviderAuthentication>, CliError>;
    readonly runOAuthAuth: (
      path: string,
      providerId: string,
      command: "login" | "logout",
    ) => Effect.Effect<void, CliError>;
  }
>()("@mitome/cli/ChildHost") {
  static readonly layer = Layer.succeed(ChildHost, {
    runHost: (path, prompt) => Effect.uninterruptible(attempt(() => runHost(path, prompt))),
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
}

const ProviderAuthenticationSchema = Schema.Struct({
  id: Schema.String.check(Schema.isNonEmpty()),
  credential: CredentialDescriptorSchema,
});
const ProviderAuthenticationsFromJson = Schema.fromJsonString(
  Schema.Array(ProviderAuthenticationSchema),
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
  "process.exit(0);",
].join("\n");

const listExports = async (
  packageName: string,
  directory: string,
): Promise<ReadonlyArray<string>> => {
  const moduleUrl = pathToFileURL(Bun.resolveSync(packageName, directory)).href;
  const outputDirectory = await mkdtemp(join(tmpdir(), "mitome-exports-"));
  // The names travel via file rather than stdout: importing the package may print.
  const output = join(outputDirectory, "exports.json");
  try {
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", "--eval", exportProbeSource, moduleUrl, output],
      { env: childEnv, stdout: "ignore", stderr: "ignore", timeout: 5000 },
    );
    if ((await child.exited) !== 0) throw new Error(`Could not inspect ${packageName} exports.`);
    // The probe script two lines up is our own code; its output needs no schema validation.
    return JSON.parse(await readFile(output, "utf8")) as ReadonlyArray<string>;
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
};

const inspectExtensions = async (path: string): Promise<ExtensionListResult> => {
  const directory = await mkdtemp(join(tmpdir(), "mitome-extensions-"));
  const output = join(directory, "extensions.json");
  try {
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", "--eval", extensionsHostSource, path, output],
      { env: childEnv, stdout: "ignore", stderr: "inherit" },
    );
    const exitCode = await child.exited;
    if (exitCode !== 0) return { exitCode, extensions: [] };
    return {
      exitCode,
      // The embedded host writes this private file; no untrusted input crosses the boundary.
      extensions: JSON.parse(await readFile(output, "utf8")) as ReadonlyArray<ExtensionListItem>,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const runHost = (path: string, prompt: string): Promise<ExitCode> =>
  runEmbeddedHost(hostSource, path, prompt);

export const runEmbeddedHost = async (
  source: string,
  path: string,
  prompt: string,
  preload?: string,
): Promise<ExitCode> => {
  const directory = configDirectory();
  // Both flags suppress Bun's automatic cwd .env autoload in the child; the
  // config .env is loaded explicitly when a config directory exists.
  const envFlag =
    directory === undefined ? "--no-env-file" : `--env-file=${join(directory, ".env")}`;
  const preloadArgs = preload === undefined ? [] : ["--preload", preload];
  const child = Bun.spawn(
    [process.execPath, envFlag, ...preloadArgs, "--eval", source, path, prompt],
    {
      // Bare preload specifiers (e.g. @opentui/solid/preload) resolve from the
      // child's cwd, and compiled binaries cannot resolve subpath exports
      // parent-side (ADR-0038) — so run the child beside the Agent Definition.
      ...(preload === undefined ? {} : { cwd: dirname(path) }),
      env: childEnv,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const forwardSigint = () => child.kill("SIGINT");
  process.once("SIGINT", forwardSigint);
  try {
    return await child.exited;
  } finally {
    process.off("SIGINT", forwardSigint);
  }
};

const inspectProviderAuthentication = async (
  path: string,
): Promise<ReadonlyArray<ProviderAuthentication>> => {
  const directory = await mkdtemp(join(tmpdir(), "mitome-auth-"));
  // The descriptor travels via file rather than stdout: importing the Agent Definition
  // may print, and stdout stays ignored so nothing leaks into the prompt flow.
  const output = join(directory, "credential.json");
  try {
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", "--eval", authHostSource, path, output],
      {
        env: childEnv,
        stdout: "ignore",
        stderr: "inherit",
      },
    );
    if ((await child.exited) !== 0)
      throw new Error("Could not inspect Agent Definition authentication.");
    const authentication = Schema.decodeResult(ProviderAuthenticationsFromJson, {
      onExcessProperty: "error",
    })(await readFile(output, "utf8"));
    if (Result.isFailure(authentication)) {
      throw new Error("Agent Definition returned invalid Provider authentication metadata.");
    }
    return authentication.success;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
      authHostSource,
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
