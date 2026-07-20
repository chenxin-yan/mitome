import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, Exit, Layer } from "effect";
import { TestConsole } from "effect/testing";
import { CliOutput } from "effect/unstable/cli";
import { describe, expect, test, vi } from "vitest";
import cliPackage from "../package.json" with { type: "json" };

vi.mock("../src/hosts/host.ts", () => ({ default: "" }));
vi.mock("../src/hosts/auth-host.ts", () => ({ default: "" }));

import { runCli } from "../src/index.ts";

const services = Layer.mergeAll(
  BunServices.layer,
  TestConsole.layer,
  CliOutput.layer(CliOutput.defaultFormatter({ colors: false })),
);

const run = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(runCli(args));
    return {
      exit,
      stderr: yield* TestConsole.errorLines,
      stdout: yield* TestConsole.logLines,
    };
  }).pipe(Effect.provide(services), Effect.runPromise);

describe("mitome command", () => {
  test("renders root and nested help, version, and completions without handlers", async () => {
    expect(await run(["--help"])).toMatchObject({
      exit: expect.objectContaining({ _tag: "Success" }),
      stdout: expect.arrayContaining([expect.stringContaining("mitome")]),
    });
    expect(await run(["auth", "login", "--help"])).toMatchObject({
      exit: expect.objectContaining({ _tag: "Success" }),
      stdout: expect.arrayContaining([expect.stringContaining("login")]),
    });
    expect(await run(["--version"])).toMatchObject({
      exit: expect.objectContaining({ _tag: "Success" }),
      stdout: [`mitome v${cliPackage.version}`],
    });
    expect(await run(["--completions", "bash"])).toMatchObject({
      exit: expect.objectContaining({ _tag: "Success" }),
      stdout: expect.arrayContaining([expect.stringContaining("mitome")]),
    });
  });

  test("uses native parse errors for malformed syntax", async () => {
    for (const args of [
      [],
      ["auth", "bogus"],
      ["init", "extra"],
      ["install", "--use"],
      ["--unknown"],
    ]) {
      const result = await run(args);
      expect(Exit.isFailure(result.exit)).toBe(true);
      expect(result.stderr.join("\n")).toContain("ERROR");
      expect(result.stdout.join("\n")).toContain("USAGE");
    }
  });
});
