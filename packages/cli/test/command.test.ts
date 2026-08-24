import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { TestConsole } from "effect/testing";
import { CliOutput } from "effect/unstable/cli";
import cliPackage from "../package.json" with { type: "json" };

import { ChildHost } from "../src/child-host-service.ts";
import { runCli } from "../src/index.ts";
import { Prompter } from "../src/prompter.ts";

const unused = Effect.die("Command handler unexpectedly ran");
const services = Layer.mergeAll(
  BunServices.layer,
  TestConsole.layer,
  CliOutput.layer(CliOutput.defaultFormatter({ colors: false })),
  Layer.succeed(ChildHost, {
    runHost: () => unused,
    install: () => unused,
    removeDependency: () => unused,
    listExports: () => unused,
    inspectExtensions: () => unused,
    inspectProviderAuthentication: () => unused,
    runOAuthAuth: () => unused,
  }),
  Layer.succeed(Prompter, {
    canPrompt: Effect.succeed(false),
    select: () => unused,
    text: () => unused,
    password: () => unused,
  }),
);

describe("mitome command", () => {
  it.effect("renders root and nested help, version, and completions without handlers", () =>
    Effect.gen(function* () {
      const helpExit = yield* Effect.exit(runCli(["--help"]));
      expect(helpExit).toEqual(expect.objectContaining({ _tag: "Success" }));
      expect(yield* TestConsole.logLines).toEqual(
        expect.arrayContaining([expect.stringContaining("mitome")]),
      );

      const loginHelpExit = yield* Effect.exit(runCli(["auth", "login", "--help"]));
      expect(loginHelpExit).toEqual(expect.objectContaining({ _tag: "Success" }));
      expect(yield* TestConsole.logLines).toEqual(
        expect.arrayContaining([expect.stringContaining("login")]),
      );

      const beforeVersion = (yield* TestConsole.logLines).length;
      const versionExit = yield* Effect.exit(runCli(["--version"]));
      expect(versionExit).toEqual(expect.objectContaining({ _tag: "Success" }));
      expect((yield* TestConsole.logLines).slice(beforeVersion)).toEqual([
        `mitome v${cliPackage.version}`,
      ]);

      const completionsExit = yield* Effect.exit(runCli(["--completions", "bash"]));
      expect(completionsExit).toEqual(expect.objectContaining({ _tag: "Success" }));
      expect(yield* TestConsole.logLines).toEqual(
        expect.arrayContaining([expect.stringContaining("mitome")]),
      );
    }).pipe(Effect.provide(services)),
  );

  it.effect("uses native parse errors for malformed syntax", () =>
    Effect.gen(function* () {
      for (const args of [
        ["auth", "bogus"],
        ["init", "extra"],
        ["install", "--use"],
        ["--unknown"],
      ]) {
        const stderrBefore = (yield* TestConsole.errorLines).length;
        const stdoutBefore = (yield* TestConsole.logLines).length;
        const exit = yield* Effect.exit(runCli(args));
        expect(Exit.isFailure(exit)).toBe(true);
        expect((yield* TestConsole.errorLines).slice(stderrBefore).join("\n")).toContain("ERROR");
        expect((yield* TestConsole.logLines).slice(stdoutBefore).join("\n")).toContain("USAGE");
      }
    }).pipe(Effect.provide(services)),
  );
});
