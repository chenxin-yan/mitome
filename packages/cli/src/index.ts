import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, Layer } from "effect";
import { CliOutput, Command } from "effect/cli";
import cliPackage from "../package.json" with { type: "json" };

const command = Command.make("mitome").pipe(Command.withDescription("Mitome command line"));

export const runCli = Command.runWith(command, { version: cliPackage.version });

if (import.meta.main) {
  const platform = Layer.merge(BunServices.layer, CliOutput.layer(CliOutput.defaultFormatter()));
  BunRuntime.runMain(runCli(process.argv.slice(2)).pipe(Effect.provide(platform)));
}
