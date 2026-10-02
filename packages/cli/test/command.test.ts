import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as BunServices from "@effect/platform-bun/BunServices";
import { afterAll, beforeEach, describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Predicate, Sink, Stdio, Stream } from "effect";
import { TestConsole } from "effect/testing";
import { CliOutput } from "effect/cli";
import cliPackage from "../package.json" with { type: "json" };

import { runCli } from "../src/index.ts";

const fixture = fileURLToPath(new URL("fixtures/app.ts", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "mitome-cli-"));
const log = join(directory, "events.log");
const credentials = join(directory, "credentials");
// Read when the fixture module is first imported, so set before any command runs.
process.env.MITOME_FIXTURE_LOG = log;
process.env.MITOME_FIXTURE_CREDENTIALS = credentials;

afterAll(() => rm(directory, { recursive: true, force: true }));
beforeEach(() => writeFile(log, ""));

const events = Effect.promise(async () =>
  (await readFile(log, "utf8")).split("\n").filter(Boolean),
);

interface Io {
  readonly stdout: Array<string>;
}

/** Runs the CLI in-process with scripted standard I/O. */
const cli = (
  args: ReadonlyArray<string>,
  options: { readonly stdin?: Stream.Stream<Uint8Array>; readonly terminal?: boolean } = {},
) =>
  Effect.gen(function* () {
    const io: Io = { stdout: [] };
    const stdio = Stdio.layerTest({
      stdin: options.stdin ?? Stream.die(new Error("stdin must not be read")),
      stdinIsTerminal: Effect.succeed(options.terminal ?? false),
      stdout: () =>
        Sink.forEach((chunk) =>
          Effect.sync(() =>
            io.stdout.push(Predicate.isString(chunk) ? chunk : new TextDecoder().decode(chunk)),
          ),
        ),
    });
    const services = Layer.mergeAll(
      BunServices.layer,
      TestConsole.layer,
      CliOutput.layer(CliOutput.defaultFormatter({ colors: false })),
      stdio,
    );
    return yield* Effect.gen(function* () {
      // The test console keeps earlier commands' lines; report only this command's.
      const logged = (yield* TestConsole.logLines).length;
      const errored = (yield* TestConsole.errorLines).length;
      const exit = yield* Effect.exit(runCli(args));
      return {
        exit,
        stdout: io.stdout.join(""),
        logs: (yield* TestConsole.logLines).slice(logged).join("\n"),
        errors: (yield* TestConsole.errorLines).slice(errored).join("\n"),
      };
    }).pipe(Effect.provide(services));
  });

const stdin = (text: string) => Stream.make(new TextEncoder().encode(text));

describe("mitome command", () => {
  it.effect("renders help and version", () =>
    Effect.gen(function* () {
      const help = yield* cli(["--help"]);
      expect(Exit.isSuccess(help.exit)).toBe(true);
      for (const name of ["run", "providers", "auth"]) expect(help.logs).toContain(name);

      const version = yield* cli(["--version"]);
      expect(Exit.isSuccess(version.exit)).toBe(true);
      expect(version.logs).toBe(`mitome v${cliPackage.version}`);
    }),
  );

  it.effect("rejects unknown flags and a missing --app with native parse errors", () =>
    Effect.gen(function* () {
      for (const args of [["--unknown"], ["run", "hello"], ["providers"]]) {
        const result = yield* cli(args);
        expect(Exit.isFailure(result.exit)).toBe(true);
        expect(result.errors).toContain("ERROR");
      }
      expect(yield* events).toEqual([]);
    }),
  );
});

describe("mitome run", () => {
  it.effect("runs one Turn through the application and renders only its result to stdout", () =>
    Effect.gen(function* () {
      const result = yield* cli(["run", "--app", fixture, "hello"]);
      expect(Exit.isSuccess(result.exit)).toBe(true);
      expect(result.stdout).toBe("> echo: hello\n");
      expect(result.errors).toBe("");
      expect(yield* events).toEqual([
        "infra:acquire",
        "provision:echo",
        "program:hello",
        "release-model:echo",
        "infra:release",
      ]);
    }),
  );

  it.effect("prefers the argument over stdin and reads non-terminal stdin as one payload", () =>
    Effect.gen(function* () {
      const argument = yield* cli(["run", "--app", fixture, "from argument"], {
        stdin: Stream.die(new Error("stdin must not be read")),
      });
      expect(argument.stdout).toBe("> echo: from argument\n");

      const piped = yield* cli(["run", "--app", fixture], {
        stdin: Stream.concat(stdin("first line\n"), stdin("second line\n")),
      });
      expect(Exit.isSuccess(piped.exit)).toBe(true);
      expect(piped.stdout).toBe("> echo: first line\nsecond line\n");

      yield* Effect.promise(() => writeFile(log, ""));
      const terminal = yield* cli(["run", "--app", fixture], { terminal: true });
      expect(Exit.isFailure(terminal.exit)).toBe(true);
      expect(terminal.errors).toContain("Provide input as an argument or on standard input.");
      expect(yield* events).toEqual([]);
    }),
  );

  it.effect("selects explicit Models lazily and rejects bad selections before acquisition", () =>
    Effect.gen(function* () {
      const unlisted = yield* cli([
        "run",
        "--app",
        fixture,
        "--model",
        "scripted/private/fine-tune",
        "hi",
      ]);
      expect(unlisted.stdout).toBe("> private/fine-tune: hi\n");

      for (const [args, message] of [
        [["--model", "no-separator"], '"no-separator" is not a Qualified Model id'],
        [["--provider", "missing"], 'unknown Provider "missing" (declared: scripted, oauth)'],
        [["--provider", "oauth"], 'configures no Model of Provider "oauth"'],
        [["--provider", "oauth", "--model", "scripted/echo"], "does not belong to Provider"],
        [["--grace", "0s"], 'Invalid grace "0s"'],
      ] as const) {
        yield* Effect.promise(() => writeFile(log, ""));
        const result = yield* cli(["run", "--app", fixture, ...args, "hi"]);
        expect(Exit.isFailure(result.exit)).toBe(true);
        expect(result.errors).toContain(message);
        expect(result.stdout).toBe("");
        expect(yield* events).toEqual([]);
      }
    }),
  );

  it.effect("reports application failures on stderr and releases everything", () =>
    Effect.gen(function* () {
      const result = yield* cli(["run", "--app", fixture, "fail"]);
      expect(Exit.isFailure(result.exit)).toBe(true);
      expect(result.stdout).toBe("");
      expect(result.errors).toContain("The application failed: refused: asked to fail");
      expect((yield* events).at(-1)).toBe("infra:release");
    }),
  );

  it.effect("never enters the program when parsing fails, and never reruns a failed render", () =>
    Effect.gen(function* () {
      const unparsed = yield* cli(["run", "--app", fixture, "unparseable"]);
      expect(Exit.isFailure(unparsed.exit)).toBe(true);
      expect(unparsed.stdout).toBe("");
      expect(unparsed.errors).toContain("Could not parse the input: unparseable input");
      expect(yield* events).toEqual([
        "infra:acquire",
        "provision:echo",
        "release-model:echo",
        "infra:release",
      ]);

      yield* Effect.promise(() => writeFile(log, ""));
      const unrendered = yield* cli(["run", "--app", fixture, "unrenderable"]);
      expect(Exit.isFailure(unrendered.exit)).toBe(true);
      expect(unrendered.stdout).toBe("");
      expect(unrendered.errors).toContain(
        "The Turn committed, but its result could not be rendered: refused: cannot render",
      );
      expect(yield* events).toEqual([
        "infra:acquire",
        "provision:echo",
        "program:unrenderable",
        "release-model:echo",
        "infra:release",
      ]);
    }),
  );

  it.effect("rejects modules that are not mitome/1 applications without calling them", () =>
    Effect.gen(function* () {
      const write = (name: string, source: string) =>
        Effect.promise(async () => {
          const path = join(directory, name);
          await writeFile(path, source);
          return path;
        });
      const cases = [
        [yield* write("named.ts", "export const app = {};\n"), "must default-export"],
        [
          yield* write("old.ts", 'export default { protocol: "mitome/0" };\n'),
          "is not a mitome/1 application",
        ],
        [
          yield* write(
            "not-effect.ts",
            'export default { protocol: "mitome/1", discovery: [], cli: { parseInput: () => 1, renderResult: () => 1 }, acquire: () => 123 };\n',
          ),
          "The application's acquire did not return an Effect",
        ],
        [join(directory, "missing.ts"), "Could not load"],
      ] as const;
      for (const [path, message] of cases) {
        const result = yield* cli(["run", "--app", path, "hi"]);
        expect(Exit.isFailure(result.exit)).toBe(true);
        expect(result.errors).toContain(message);
      }
    }),
  );
});

describe("mitome providers and auth", () => {
  it.effect("lists Providers and offline credential status without acquiring anything", () =>
    Effect.gen(function* () {
      const providers = yield* cli(["providers", "--app", fixture]);
      expect(Exit.isSuccess(providers.exit)).toBe(true);
      expect(providers.logs).toBe(
        [
          "scripted",
          "  scripted/echo (context window 8192)",
          "oauth",
          "default: scripted/echo",
          "Catalogs are hints; any Provider-native Model id can be selected.",
        ].join("\n"),
      );

      delete process.env.FIXTURE_API_KEY;
      const missing = yield* cli(["auth", "status", "--app", fixture]);
      expect(missing.logs).toBe(
        [
          "scripted: FIXTURE_API_KEY missing",
          "oauth: auth capability available; credential status unknown",
        ].join("\n"),
      );
      process.env.FIXTURE_API_KEY = "secret-value";
      const present = yield* cli(["auth", "status", "--app", fixture, "--provider", "scripted"]);
      delete process.env.FIXTURE_API_KEY;
      expect(present.logs).toBe("scripted: FIXTURE_API_KEY present");
      expect(present.logs).not.toContain("secret-value");
      expect(yield* events).toEqual([]);
    }),
  );

  it.effect("delegates login and logout to the selected Provider's capability", () =>
    Effect.gen(function* () {
      const ambiguous = yield* cli(["auth", "login", "--app", fixture]);
      expect(Exit.isFailure(ambiguous.exit)).toBe(true);
      expect(ambiguous.errors).toContain("Choose a Provider with --provider: scripted, oauth");

      const environment = yield* cli(["auth", "login", "--app", fixture, "--provider", "scripted"]);
      expect(Exit.isSuccess(environment.exit)).toBe(true);
      expect(environment.logs).toContain("export FIXTURE_API_KEY=<key>");
      expect(environment.logs).toContain("Mitome does not store it.");

      for (const operation of ["login", "logout"]) {
        const result = yield* cli(["auth", operation, "--app", fixture, "--provider", "oauth"]);
        expect(Exit.isSuccess(result.exit)).toBe(true);
      }
      // Only the capability ran, against the application's credential directory.
      expect(yield* events).toEqual([`auth:login:${credentials}`, `auth:logout:${credentials}`]);
    }),
  );
});
