import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Cause, Effect, Layer, Logger, Runtime } from "effect";
import { Argument, CliOutput, Command, Flag } from "effect/cli";
import { providerChoices } from "create-mitome/template";
import cliPackage from "../package.json" with { type: "json" };
import { describe } from "./errors.js";
import { initConfiguration } from "./init.js";
import {
  authenticate,
  authStatus,
  listProviders,
  parseGrace,
  runApplication,
  runTerminalApplication,
} from "./commands.js";

const config = Flag.String("config").pipe(
  Flag.withDescription(
    "Configuration to load: a directory (its index.ts) or a file; default <config directory>/index.ts",
  ),
  Flag.optional,
);
const provider = Flag.String("provider").pipe(
  Flag.withDescription("Provider id to select or authenticate"),
  Flag.optional,
);

const model = Flag.String("model").pipe(
  Flag.withDescription("Qualified Model id (provider/model); never falls back"),
  Flag.optional,
);
const resume = Flag.String("continue").pipe(
  Flag.withOptionalValue(""),
  Flag.withMetavar("id"),
  Flag.withDescription(
    "Continue the conversation most recently written in this directory, or with =<id> the one with that id",
  ),
  Flag.optional,
);
const grace = Flag.String("grace").pipe(
  Flag.mapTryCatch(parseGrace, describe),
  Flag.withDefault(5000),
  Flag.withDescription("How long shutdown may take once it begins, as <n>ms or <n>s"),
);

const run = Command.make(
  "run",
  {
    config,
    provider,
    model,
    grace,
    continue: resume,
    input: Argument.String("input").pipe(
      Argument.withDescription("Input text; without it, non-terminal standard input is read"),
      Argument.optional,
    ),
  },
  runApplication,
).pipe(Command.withDescription("Run the Configuration's Agent once for one input"));

const providers = Command.make("providers", { config }, ({ config }) => listProviders(config)).pipe(
  Command.withDescription("List the Configuration's Providers and Model hints"),
);

const init = Command.make(
  "init",
  {
    provider: Flag.ChoiceWithValue(
      "provider",
      providerChoices.map((choice) => [choice.id, choice] as const),
    ).pipe(
      Flag.withDescription(
        "Provider the Configuration runs with; asked on a terminal when omitted",
      ),
      Flag.optional,
    ),
    model: Flag.String("model").pipe(
      Flag.withDescription(
        "That Provider's Model id, without the provider/ prefix; asked on a terminal when omitted",
      ),
      Flag.optional,
    ),
    noInstall: Flag.Boolean("no-install").pipe(
      Flag.withoutNegation,
      Flag.withDefault(false),
      Flag.withDescription("Write the files without installing their dependencies"),
    ),
  },
  initConfiguration,
).pipe(
  Command.withDescription(
    "Write the default Configuration into the config directory and install its dependencies",
  ),
);

const auth = Command.make("auth").pipe(
  Command.withDescription("Inspect or change the Configuration's Provider credentials"),
  Command.withSubcommands([
    Command.make("status", { config, provider }, ({ config, provider }) =>
      authStatus(config, provider),
    ).pipe(
      Command.withDescription(
        "Report where each Provider's credential comes from; stored logins are not read",
      ),
    ),
    Command.make("login", { config, provider }, ({ config, provider }) =>
      authenticate("login", config, provider),
    ).pipe(Command.withDescription("Authenticate one Provider")),
    Command.make("logout", { config, provider }, ({ config, provider }) =>
      authenticate("logout", config, provider),
    ).pipe(Command.withDescription("Remove one Provider's stored credential")),
  ]),
);

const command = Command.make(
  "mitome",
  { config, provider, model, grace, continue: resume },
  runTerminalApplication,
).pipe(
  Command.withDescription(
    "Open a Mitome Configuration's Agent in the terminal; subcommands run it once and manage its Provider logins",
  ),
  Command.withExamples([
    { command: "mitome", description: "With no subcommand, open the terminal" },
  ]),
  Command.withSubcommands([init, run, providers, auth]),
);

export const runCli = Command.runWith(command, { version: cliPackage.version });

if (import.meta.main) {
  const platform = Layer.merge(BunServices.layer, CliOutput.layer(CliOutput.defaultFormatter()));
  const main = runCli(process.argv.slice(2)).pipe(
    // runMain's own reporter would log outside this program, to stdout; stdout carries only the
    // rendered result, so unreported failures and every Configuration log go to stderr instead.
    Effect.tapCause((cause) =>
      Cause.hasInterruptsOnly(cause) || !Runtime.getErrorReported(Cause.squash(cause))
        ? Effect.void
        : Effect.logError(cause),
    ),
    Effect.provide(platform),
    Effect.provideService(Logger.LogToStderr, true),
  );
  BunRuntime.runMain(main, {
    disableErrorReporting: true,
    // Exit once the command finishes, even if the loaded module left handles open.
    teardown: (exit) => Runtime.defaultTeardown(exit, (code) => process.exit(code)),
  });
  // A closing terminal sends SIGHUP to its whole process group: shut down as on SIGTERM, within
  // the grace, instead of dying before cleanup.
  process.on("SIGHUP", () => process.emit("SIGTERM"));
}
