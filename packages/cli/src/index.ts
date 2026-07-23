import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, Layer } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";
import cliPackage from "../package.json" with { type: "json" };
import { missingUseFlag, noArguments, promptArgument, useFlag } from "./args.js";
import { runAuth } from "./commands/auth.js";
import { runInit } from "./commands/init.js";
import { runInstall, runPrompt } from "./commands/run.js";
import { fail } from "./support.js";

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
  fail("Usage: mitome auth <login|logout> [--use <path>]"),
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
