import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, Layer } from "effect";
import { Argument, CliOutput, Command, Flag } from "effect/unstable/cli";
import cliPackage from "../package.json" with { type: "json" };
import { ChildHost } from "./child-host.js";
import { runAuth } from "./commands/auth.js";
import { runAdd, runRemove } from "./commands/dependencies.js";
import { runExtensionList } from "./commands/extensions.js";
import { runInit } from "./commands/init.js";
import { runInstall, runPrompt } from "./commands/run.js";
import { Prompter } from "./prompter.js";
import { fail, type ExitCode } from "./support.js";

const useExitCode = <A extends ExitCode, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.tap((exitCode) => Effect.sync(() => (process.exitCode = exitCode))));

const useFlag = Flag.string("use").pipe(
  Flag.withDescription("Path to an Agent Definition module or directory"),
  Flag.optional,
);
const promptArgument = Argument.string("prompt").pipe(
  Argument.withDescription("Prompt to send to the Agent"),
);
const packageArgument = Argument.string("package").pipe(
  Argument.withDescription("Extension package to add or remove"),
);

const definitionCommandConfig = {
  use: useFlag,
};

const addCommand = Command.make(
  "add",
  { ...definitionCommandConfig, package: packageArgument },
  (options) => useExitCode(runAdd(options)),
).pipe(Command.withDescription("Add an Extension to the Agent Definition"));
const removeCommand = Command.make(
  "remove",
  { ...definitionCommandConfig, package: packageArgument },
  (options) => useExitCode(runRemove(options)),
).pipe(Command.withDescription("Remove an Extension from the Agent Definition"));
const extensionListCommand = Command.make("list", definitionCommandConfig, (options) =>
  useExitCode(runExtensionList(options)),
).pipe(Command.withDescription("List resolved Extensions"));
const extensionCommand = Command.make("ext", {}, () =>
  fail("Usage: mitome ext list [--use <path>]"),
).pipe(
  Command.withDescription("Inspect resolved Extensions"),
  Command.withSubcommands([extensionListCommand]),
);
const installCommand = Command.make("install", definitionCommandConfig, (options) =>
  useExitCode(runInstall(options)),
).pipe(Command.withDescription("Install Agent Definition dependencies"));
const initCommand = Command.make("init", {}, () => useExitCode(runInit())).pipe(
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
  Command.withSubcommands([
    addCommand,
    removeCommand,
    extensionCommand,
    installCommand,
    initCommand,
    authCommand,
  ]),
);

export const runCli = Command.runWith(command, { version: cliPackage.version });

if (import.meta.main) {
  const platform = Layer.merge(BunServices.layer, CliOutput.layer(CliOutput.defaultFormatter()));
  const services = Layer.merge(ChildHost.layer, Prompter.layer).pipe(Layer.provideMerge(platform));
  BunRuntime.runMain(runCli(process.argv.slice(2)).pipe(Effect.provide(services)));
}
