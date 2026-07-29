import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, Layer } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";
import cliPackage from "../package.json" with { type: "json" };
import { promptArgument, useFlag } from "./args.js";
import { childHostLayer } from "./child-host.js";
import { runAuth } from "./commands/auth.js";
import { runInit } from "./commands/init.js";
import { runInstall, runPrompt } from "./commands/run.js";
import { prompterLayer } from "./prompter.js";
import { fail, type ExitCode } from "./support.js";

const useExitCode = <A extends ExitCode, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.tap((exitCode) => Effect.sync(() => (process.exitCode = exitCode))));

const definitionCommandConfig = {
  use: useFlag,
};

const installCommand = Command.make("install", definitionCommandConfig, (options) =>
  useExitCode(runInstall(options)),
).pipe(Command.withDescription("Install Agent Definition dependencies"));
const initCommand = Command.make("init", {}, () => useExitCode(runInit)).pipe(
  Command.withDescription("Create a default Agent Definition"),
);
const loginCommand = Command.make("login", definitionCommandConfig, ({ use }) =>
  useExitCode(runAuth("login", use)),
);
const logoutCommand = Command.make("logout", definitionCommandConfig, ({ use }) =>
  useExitCode(runAuth("logout", use)),
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
  (options) => useExitCode(runPrompt(options)),
).pipe(
  Command.withDescription("Run an Agent Definition"),
  Command.withSubcommands([installCommand, initCommand, authCommand]),
);

export const runCli = Command.runWith(command, { version: cliPackage.version });

if (import.meta.main) {
  const platform = Layer.merge(BunServices.layer, CliOutput.layer(CliOutput.defaultFormatter()));
  const services = Layer.merge(childHostLayer, prompterLayer).pipe(Layer.provideMerge(platform));
  BunRuntime.runMain(runCli(process.argv.slice(2)).pipe(Effect.provide(services)));
}
