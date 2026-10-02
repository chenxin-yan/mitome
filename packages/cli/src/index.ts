import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, Layer, Runtime } from "effect";
import { Argument, CliOutput, Command, Flag } from "effect/cli";
import cliPackage from "../package.json" with { type: "json" };
import { describe } from "./application.js";
import { authenticate, authStatus, listProviders, parseGrace, runApplication } from "./commands.js";

const app = Flag.String("app").pipe(
  Flag.withDescription("Application module whose default export is defineMitome(...)"),
);
const provider = Flag.String("provider").pipe(
  Flag.withDescription("Provider id to select or authenticate"),
  Flag.optional,
);

const run = Command.make(
  "run",
  {
    app,
    provider,
    model: Flag.String("model").pipe(
      Flag.withDescription("Qualified Model id (provider/model); never falls back"),
      Flag.optional,
    ),
    grace: Flag.String("grace").pipe(
      Flag.mapTryCatch(parseGrace, describe),
      Flag.withDefault(5000),
      Flag.withDescription("How long shutdown may take after SIGINT/SIGTERM, as <n>ms or <n>s"),
    ),
    input: Argument.String("input").pipe(
      Argument.withDescription("Input text; without it, non-terminal standard input is read"),
      Argument.optional,
    ),
  },
  runApplication,
).pipe(Command.withDescription("Run the application's program once for one input"));

const providers = Command.make("providers", { app }, ({ app }) => listProviders(app)).pipe(
  Command.withDescription("List the application's Providers and Model hints"),
);

const auth = Command.make("auth").pipe(
  Command.withDescription("Inspect or change the application's Provider credentials"),
  Command.withSubcommands([
    Command.make("status", { app, provider }, ({ app, provider }) =>
      authStatus(app, provider),
    ).pipe(Command.withDescription("Report credentials without validating them")),
    Command.make("login", { app, provider }, ({ app, provider }) =>
      authenticate("login", app, provider),
    ).pipe(Command.withDescription("Authenticate one Provider")),
    Command.make("logout", { app, provider }, ({ app, provider }) =>
      authenticate("logout", app, provider),
    ).pipe(Command.withDescription("Remove one Provider's stored credential")),
  ]),
);

const command = Command.make("mitome").pipe(
  Command.withDescription("Run and set up a native Mitome application"),
  Command.withSubcommands([run, providers, auth]),
);

export const runCli = Command.runWith(command, { version: cliPackage.version });

if (import.meta.main) {
  const platform = Layer.merge(BunServices.layer, CliOutput.layer(CliOutput.defaultFormatter()));
  BunRuntime.runMain(runCli(process.argv.slice(2)).pipe(Effect.provide(platform)), {
    // Exit once the command finishes, even if the loaded module left handles open.
    teardown: (exit) => Runtime.defaultTeardown(exit, (code) => process.exit(code)),
  });
}
