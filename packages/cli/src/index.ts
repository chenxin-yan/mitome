import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, Layer } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";
import cliPackage from "../package.json" with { type: "json" };
import { promptArgument, useFlag } from "./args.js";
import { runAuth } from "./commands/auth.js";
import { runInit } from "./commands/init.js";
import { runInstall, runPrompt } from "./commands/run.js";
import { fail, promptTerminal } from "./support.js";

const definitionCommandConfig = {
  use: useFlag,
};

const installCommand = Command.make("install", definitionCommandConfig, runInstall).pipe(
  Command.withDescription("Install Agent Definition dependencies"),
);
const initCommand = Command.make("init", {}, () => runInit).pipe(
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

const command = Command.make(
  "mitome",
  {
    prompt: promptArgument,
    use: useFlag,
  },
  runPrompt,
).pipe(
  Command.withDescription("Run an Agent Definition"),
  Command.withSubcommands([installCommand, initCommand, authCommand]),
);

export const runCli = Command.runWith(command, { version: cliPackage.version });

if (import.meta.main) {
  // promptTerminal is merged last so its Terminal overrides the BunServices one.
  const services = Layer.mergeAll(
    BunServices.layer,
    CliOutput.layer(CliOutput.defaultFormatter()),
    promptTerminal,
  );
  BunRuntime.runMain(runCli(process.argv.slice(2)).pipe(Effect.provide(services)));
}
