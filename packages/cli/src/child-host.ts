import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type CredentialDescriptor } from "@mitome/core";
import { configDirectory, emptyEnvFile, requireConfigDirectory } from "./config.js";
// Bun embeds hosts as source text at compile time; static analysis sees modules without default exports.
// @ts-expect-error
// oxlint-disable-next-line import/default
import definitionHost from "./hosts/host.ts" with { type: "text" };
// @ts-expect-error
// oxlint-disable-next-line import/default
import authHost from "./hosts/auth-host.ts" with { type: "text" };

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

export const inspectCredential = async (path: string): Promise<CredentialDescriptor> => {
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

export const runOAuthAuth = async (path: string, command: "login" | "logout"): Promise<void> => {
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
