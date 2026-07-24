import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configDirectory, type CredentialDescriptor } from "@mitome/core";
import { emptyEnvFile, requireConfigDirectory } from "./config.js";
// Bun embeds hosts as source text at compile time; static analysis sees modules without default exports.
// @ts-expect-error
// oxlint-disable-next-line import/default
import definitionHost from "./hosts/host.ts" with { type: "text" };
// @ts-expect-error
// oxlint-disable-next-line import/default
import authHost from "./hosts/auth-host.ts" with { type: "text" };

const hostSource: string = definitionHost;
const authHostSource: string = authHost;

export interface ProviderAuthentication {
  readonly id: string;
  readonly credential: CredentialDescriptor;
}

const isCredentialDescriptor = (value: unknown): value is CredentialDescriptor =>
  typeof value === "string"
    ? /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
    : typeof value === "object" &&
      value !== null &&
      Object.keys(value).length === 1 &&
      "capability" in value &&
      typeof value.capability === "object" &&
      value.capability !== null &&
      Object.keys(value.capability).length === 1 &&
      "module" in value.capability &&
      typeof value.capability.module === "string";

// Validates untrusted JSON crossing the auth-host process boundary.
const isProviderAuthentication = (value: unknown): value is ProviderAuthentication =>
  typeof value === "object" &&
  value !== null &&
  Object.keys(value).length === 2 &&
  "id" in value &&
  typeof value.id === "string" &&
  value.id !== "" &&
  "credential" in value &&
  isCredentialDescriptor(value.credential);

// No SIGINT forwarding (unlike runHost): the installer is short-lived and
// terminal Ctrl-C reaches it through the process group.
export const install = async (path: string): Promise<void> => {
  const child = Bun.spawn([process.execPath, "install"], {
    cwd: dirname(path),
    env: { ...process.env, BUN_BE_BUN: "1" },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = await child.exited;
};

export const runHost = async (path: string, prompt: string): Promise<void> => {
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

export const inspectProviderAuthentication = async (
  path: string,
): Promise<ReadonlyArray<ProviderAuthentication>> => {
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
    const authentication: unknown = JSON.parse(await readFile(output, "utf8"));
    if (!Array.isArray(authentication) || !authentication.every(isProviderAuthentication)) {
      throw new Error("Agent Definition returned invalid Provider authentication metadata.");
    }
    return authentication;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

export const runOAuthAuth = async (
  path: string,
  providerId: string,
  command: "login" | "logout",
): Promise<void> => {
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
      providerId,
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
