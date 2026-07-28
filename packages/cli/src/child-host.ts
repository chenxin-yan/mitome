import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Result, Schema } from "effect";
import { configDirectory, type CredentialDescriptor } from "@mitome/core";
import { requireConfigDirectory } from "./config.js";
// Bun embeds hosts as source text at compile time; static analysis sees modules without default exports.
// @ts-expect-error
// oxlint-disable-next-line import/default
import definitionHost from "./hosts/host.ts" with { type: "text" };
// @ts-expect-error
// oxlint-disable-next-line import/default
import authHost from "./hosts/auth-host.ts" with { type: "text" };

const hostSource: string = definitionHost;
const authHostSource: string = authHost;
// process.execPath is the compiled mitome binary; BUN_BE_BUN re-executes it as plain Bun.
const childEnv = { ...process.env, BUN_BE_BUN: "1" };

export interface ProviderAuthentication {
  readonly id: string;
  readonly credential: CredentialDescriptor;
}

const CredentialDescriptorSchema = Schema.Union([
  Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/)),
  Schema.Struct({ capability: Schema.Struct({ module: Schema.String }) }),
]);
const ProviderAuthenticationSchema = Schema.Struct({
  id: Schema.String.check(Schema.isNonEmpty()),
  credential: CredentialDescriptorSchema,
});
const ProviderAuthenticationsFromJson = Schema.fromJsonString(
  Schema.Array(ProviderAuthenticationSchema),
);

// No SIGINT forwarding (unlike runHost): the installer is short-lived and
// terminal Ctrl-C reaches it through the process group.
export const install = async (path: string): Promise<number> => {
  const child = Bun.spawn([process.execPath, "install"], {
    cwd: dirname(path),
    env: childEnv,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
};

export const runHost = async (path: string, prompt: string): Promise<number> => {
  const directory = configDirectory();
  // Both flags suppress Bun's automatic cwd .env autoload in the child; the
  // config .env is loaded explicitly when a config directory exists.
  const envFlag =
    directory === undefined ? "--no-env-file" : `--env-file=${join(directory, ".env")}`;
  const child = Bun.spawn([process.execPath, envFlag, "--eval", hostSource, path, prompt], {
    env: childEnv,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const forwardSigint = () => child.kill("SIGINT");
  process.once("SIGINT", forwardSigint);
  try {
    return await child.exited;
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
      [process.execPath, "--no-env-file", "--eval", authHostSource, path, output],
      {
        env: childEnv,
        stdout: "ignore",
        stderr: "inherit",
      },
    );
    if ((await child.exited) !== 0)
      throw new Error("Could not inspect Agent Definition authentication.");
    const authentication = Schema.decodeUnknownResult(ProviderAuthenticationsFromJson, {
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

export const runOAuthAuth = async (
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
