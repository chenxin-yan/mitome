import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { TestConsole } from "effect/testing";
import { CliOutput } from "effect/cli";
import cliPackage from "../package.json" with { type: "json" };

import { runCli } from "../src/index.ts";

const services = Layer.mergeAll(
  BunServices.layer,
  TestConsole.layer,
  CliOutput.layer(CliOutput.defaultFormatter({ colors: false })),
);

describe("mitome command", () => {
  it.effect("renders help and version", () =>
    Effect.gen(function* () {
      const helpExit = yield* Effect.exit(runCli(["--help"]));
      expect(Exit.isSuccess(helpExit)).toBe(true);
      expect((yield* TestConsole.logLines).join("\n")).toContain("mitome");

      const beforeVersion = (yield* TestConsole.logLines).length;
      const versionExit = yield* Effect.exit(runCli(["--version"]));
      expect(Exit.isSuccess(versionExit)).toBe(true);
      expect((yield* TestConsole.logLines).slice(beforeVersion)).toEqual([
        `mitome v${cliPackage.version}`,
      ]);
    }).pipe(Effect.provide(services)),
  );

  it.effect("rejects unknown flags with a native parse error", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(runCli(["--unknown"]));
      expect(Exit.isFailure(exit)).toBe(true);
      expect((yield* TestConsole.errorLines).join("\n")).toContain("ERROR");
    }).pipe(Effect.provide(services)),
  );
});
