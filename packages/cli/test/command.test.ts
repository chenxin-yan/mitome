import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as BunServices from "@effect/platform-bun/BunServices";
import { afterAll, beforeEach, describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Layer, Predicate, Sink, Stdio, Stream } from "effect";
import { TestConsole } from "effect/testing";
import { CliOutput } from "effect/cli";
import cliPackage from "../package.json" with { type: "json" };

import { runCli } from "../src/index.ts";

const fixture = fileURLToPath(new URL("fixtures/config", import.meta.url));
const relativeFixture = fileURLToPath(new URL("fixtures/relative", import.meta.url));
const historyFixture = fileURLToPath(new URL("fixtures/history", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "mitome-cli-"));
const log = join(directory, "events.log");
// Holds both the default Configuration and the stored credentials.
const home = join(directory, "home");
process.env.MITOME_FIXTURE_LOG = log;
process.env.MITOME_HOME = home;

const originalApiKey = process.env.FIXTURE_API_KEY;
afterAll(async () => {
  if (originalApiKey === undefined) delete process.env.FIXTURE_API_KEY;
  else process.env.FIXTURE_API_KEY = originalApiKey;
  await rm(directory, { recursive: true, force: true });
});
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
      expect(help.logs).toContain("With no subcommand, open the terminal");

      const version = yield* cli(["--version"]);
      expect(Exit.isSuccess(version.exit)).toBe(true);
      expect(version.logs).toBe(`mitome v${cliPackage.version}`);
    }),
  );

  it.effect("rejects unknown flags with native parse errors", () =>
    Effect.gen(function* () {
      const result = yield* cli(["--unknown"]);
      expect(Exit.isFailure(result.exit)).toBe(true);
      expect(result.errors).toContain("ERROR");
      expect(yield* events).toEqual([]);
    }),
  );
});

describe("bare mitome", () => {
  it.effect("needs a terminal on stdin and stdout and loads nothing otherwise", () =>
    Effect.gen(function* () {
      for (const args of [[], ["--config", fixture]]) {
        for (const terminal of [false, true]) {
          // The test Stdio reports a non-terminal stdout either way.
          const result = yield* cli(args, { terminal });
          expect(Exit.isFailure(result.exit)).toBe(true);
          expect(result.errors).toContain(
            "mitome needs a terminal on standard input and output; use mitome run otherwise.",
          );
          expect(result.stdout).toBe("");
        }
      }
      expect(yield* events).toEqual([]);
    }),
  );

  it.effect("has no tui subcommand", () =>
    Effect.gen(function* () {
      const result = yield* cli(["tui"]);
      expect(Exit.isFailure(result.exit)).toBe(true);
      expect(result.errors).toContain('Unknown subcommand "tui" for "mitome"');
      expect(yield* events).toEqual([]);
    }),
  );

  it.effect("has no attachment or initial-input options", () =>
    Effect.gen(function* () {
      for (const args of [
        ["--config", fixture, "--attach", "http://localhost"],
        ["--config", fixture, "hello"],
      ]) {
        const result = yield* cli(args);
        expect(Exit.isFailure(result.exit)).toBe(true);
        expect(result.errors).toContain("ERROR");
      }
      expect(yield* events).toEqual([]);
    }),
  );
});

describe("selecting the Configuration", () => {
  it.effect("without --config, says how to create or select one when the default is missing", () =>
    Effect.gen(function* () {
      for (const args of [["run", "hello"], ["providers"], ["auth", "status"]]) {
        const result = yield* cli(args);
        expect(Exit.isFailure(result.exit)).toBe(true);
        expect(result.errors).toContain(`No Configuration at ${join(home, "index.ts")}`);
        expect(result.errors).toContain("npm create mitome");
        expect(result.errors).toContain("--config <path>");
      }
      expect(yield* events).toEqual([]);
    }),
  );

  it.effect("loads index.ts in the config directory by default", () =>
    Effect.gen(function* () {
      yield* Effect.promise(async () => {
        await mkdir(home, { recursive: true });
        await writeFile(
          join(home, "index.ts"),
          `export { default } from ${JSON.stringify(join(fixture, "index.ts"))};\n`,
        );
      });
      const result = yield* cli(["run", "hello"]).pipe(
        Effect.ensuring(Effect.promise(() => rm(join(home, "index.ts")))),
      );
      expect(result.stdout).toBe("> echo: hello\n");
    }),
  );

  it.effect("takes a directory as its index.ts and a file as itself", () =>
    Effect.gen(function* () {
      for (const config of [fixture, join(fixture, "index.ts")]) {
        const result = yield* cli(["run", "--config", config, "hello"]);
        expect(result.stdout).toBe("> echo: hello\n");
      }
    }),
  );

  it.effect("rejects a selection that is not an existing file, naming its path", () =>
    Effect.gen(function* () {
      const selected = join(directory, "selected");
      yield* Effect.promise(() => mkdir(join(selected, "nested", "index.ts"), { recursive: true }));
      for (const [config, message] of [
        [join(directory, "missing.ts"), `No Configuration at ${join(directory, "missing.ts")}`],
        [selected, `No Configuration at ${join(selected, "index.ts")}`],
        [join(selected, "nested"), `${join(selected, "nested", "index.ts")} is not a file`],
      ] as const) {
        const result = yield* cli(["run", "--config", config, "hi"]);
        expect(Exit.isFailure(result.exit)).toBe(true);
        expect(result.errors).toContain(message);
        expect(result.errors).toContain("--config <path>");
      }
      expect(yield* events).toEqual([]);
    }),
  );
});

describe("mitome run", () => {
  it.effect("runs one Turn through the Configuration and renders only its result to stdout", () =>
    Effect.gen(function* () {
      const result = yield* cli(["run", "--config", fixture, "hello"]);
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
      const argument = yield* cli(["run", "--config", fixture, "from argument"], {
        stdin: Stream.die(new Error("stdin must not be read")),
      });
      expect(argument.stdout).toBe("> echo: from argument\n");

      const piped = yield* cli(["run", "--config", fixture], {
        stdin: Stream.concat(stdin("first line\n"), stdin("second line\n")),
      });
      expect(Exit.isSuccess(piped.exit)).toBe(true);
      expect(piped.stdout).toBe("> echo: first line\nsecond line\n");

      yield* Effect.promise(() => writeFile(log, ""));
      const terminal = yield* cli(["run", "--config", fixture], { terminal: true });
      expect(Exit.isFailure(terminal.exit)).toBe(true);
      expect(terminal.errors).toContain("Provide input as an argument or on standard input.");
      expect(yield* events).toEqual([]);
    }),
  );

  it.effect("selects explicit Models lazily and rejects bad selections before acquisition", () =>
    Effect.gen(function* () {
      const unlisted = yield* cli([
        "run",
        "--config",
        fixture,
        "--model",
        "scripted/private/fine-tune",
        "hi",
      ]);
      expect(unlisted.stdout).toBe("> private/fine-tune: hi\n");

      for (const [args, message] of [
        [["--model", "no-separator"], '"no-separator" is not a Qualified Model id'],
        [["--provider", "missing"], 'unknown Provider "missing" (declared: scripted, oauth)'],
        [["--provider", "oauth"], 'sets no Model of Provider "oauth"'],
        [["--provider", "oauth", "--model", "scripted/echo"], "does not belong to Provider"],
        [["--grace", "0s"], 'Invalid grace "0s"'],
      ] as const) {
        yield* Effect.promise(() => writeFile(log, ""));
        const result = yield* cli(["run", "--config", fixture, ...args, "hi"]);
        expect(Exit.isFailure(result.exit)).toBe(true);
        expect(result.errors).toContain(message);
        expect(result.stdout).toBe("");
        expect(yield* events).toEqual([]);
      }
    }),
  );

  it.effect("reports Agent failures on stderr and releases everything", () =>
    Effect.gen(function* () {
      const result = yield* cli(["run", "--config", fixture, "fail"]);
      expect(Exit.isFailure(result.exit)).toBe(true);
      expect(result.stdout).toBe("");
      expect(result.errors).toContain("The Agent failed: refused: asked to fail");
      expect((yield* events).at(-1)).toBe("infra:release");
    }),
  );

  it.effect("never enters the program when parsing fails, and never reruns a failed render", () =>
    Effect.gen(function* () {
      const unparsed = yield* cli(["run", "--config", fixture, "unparseable"]);
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
      const unrendered = yield* cli(["run", "--config", fixture, "unrenderable"]);
      expect(Exit.isFailure(unrendered.exit)).toBe(true);
      expect(unrendered.stdout).toBe("");
      expect(unrendered.errors).toContain(
        "The Turn succeeded, but its result could not be rendered: refused: cannot render",
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

  it.effect("rejects modules that are not mitome/1 Configurations without calling them", () =>
    Effect.gen(function* () {
      const write = (name: string, source: string) =>
        Effect.promise(async () => {
          const path = join(directory, name);
          await writeFile(path, source);
          return path;
        });
      const cases = [
        [
          yield* write("named.ts", "export const app = {};\n"),
          "must default-export Mitome.make(...); select another with --config <path>",
        ],
        [
          yield* write("old.ts", 'export default { protocol: "mitome/0" };\n'),
          "is not a mitome/1 Configuration made by Mitome.make; select another with --config <path>",
        ],
        [
          yield* write(
            "not-effect.ts",
            'export default { protocol: "mitome/1", discovery: [], text: { parse: () => 1, render: () => 1 }, acquire: () => 123 };\n',
          ),
          "The Configuration's acquire did not return an Effect",
        ],
      ] as const;
      for (const [path, message] of cases) {
        const result = yield* cli(["run", "--config", path, "hi"]);
        expect(Exit.isFailure(result.exit)).toBe(true);
        expect(result.errors).toContain(message);
      }
    }),
  );

  it.effect(
    "names the real directory to install in, and the selected path, for a linked file",
    () =>
      Effect.gen(function* () {
        const dotfiles = join(directory, "dotfiles");
        const linked = join(directory, "linked.ts");
        yield* Effect.promise(async () => {
          await mkdir(dotfiles, { recursive: true });
          await writeFile(
            join(dotfiles, "index.ts"),
            'export { default } from "mitome-not-installed";\n',
          );
          await symlink(join(dotfiles, "index.ts"), linked);
        });
        const real = yield* Effect.promise(() => realpath(dotfiles));
        const result = yield* cli(["run", "--config", linked, "hi"]);
        expect(Exit.isFailure(result.exit)).toBe(true);
        expect(result.errors).toContain(
          `Could not load ${linked}: package "mitome-not-installed" is not installed. Run npm install in ${real}.`,
        );
      }),
  );

  it.effect(
    "calls the text mapping's methods on the mapping itself and accepts an unset model",
    () =>
      Effect.gen(function* () {
        const path = join(directory, "receiver.ts");
        yield* Effect.promise(() =>
          writeFile(
            path,
            `import fixture from ${JSON.stringify(join(fixture, "index.ts"))};
class Mapping {
  prefix = "receiver ";
  parse(text) { return fixture.text.parse(this.prefix + text); }
  render(result) { return fixture.text.render({ ...result, text: this.prefix + result.text }); }
}
export default { ...fixture, model: undefined, text: new Mapping() };
`,
          ),
        );
        const result = yield* cli(["run", "--config", path, "--model", "scripted/echo", "hello"]);
        expect(result.errors).toBe("");
        expect(result.stdout).toBe("> receiver echo: receiver hello\n");
      }),
  );
});

describe("mitome run --continue", () => {
  // Each test starts from an empty store; its CLI calls share it.
  beforeEach(() => {
    process.env.MITOME_FIXTURE_HISTORY = crypto.randomUUID();
  });

  it.effect("says that a Configuration without a store keeps no history", () =>
    Effect.gen(function* () {
      for (const flag of ["--continue", "--continue=some-id"]) {
        const result = yield* cli(["run", "--config", fixture, flag, "hello"]);
        expect(Exit.isFailure(result.exit)).toBe(true);
        expect(result.stdout).toBe("");
        expect(result.errors).toContain(
          "This Configuration keeps no history, so there is no conversation to continue.",
        );
        expect(yield* events).not.toContain("program:hello");
      }
    }),
  );

  it.effect("continues the last conversation started here, or the one its id names", () =>
    Effect.gen(function* () {
      const nothing = yield* cli(["run", "--config", historyFixture, "--continue", "hello"]);
      expect(Exit.isFailure(nothing.exit)).toBe(true);
      expect(nothing.stdout).toBe("");
      expect(nothing.errors).toContain(`There is no conversation to continue in ${process.cwd()}.`);

      const first = yield* cli(["run", "--config", historyFixture, "one"]);
      expect(first.stdout).toBe("heard: one\n");
      expect(first.errors).toBe("");

      const second = yield* cli(["run", "--config", historyFixture, "--continue", "two"]);
      expect(Exit.isSuccess(second.exit)).toBe(true);
      // The Model Context held the first run's exchange; stdout still holds only the result.
      expect(second.stdout).toBe("heard: one, two\n");
      const id = /Continued conversation (\S+) \(1 Entry\)\./.exec(second.errors)?.[1] ?? "";
      expect(id).not.toBe("");

      // A new conversation started here becomes the latest; the id still names the first one.
      expect((yield* cli(["run", "--config", historyFixture, "apart"])).stdout).toBe(
        "heard: apart\n",
      );
      const named = yield* cli(["run", "--config", historyFixture, `--continue=${id}`, "three"]);
      expect(named.stdout).toBe("heard: one, two, three\n");
      expect(named.errors).toContain(`Continued conversation ${id} (2 Entries).`);
      // Writing to it made it the conversation most recently written here again.
      const bare = yield* cli(["run", "--config", historyFixture, "--continue", "four"]);
      expect(bare.stdout).toBe("heard: one, two, three, four\n");

      const missing = yield* cli(["run", "--config", historyFixture, "--continue=missing", "x"]);
      expect(Exit.isFailure(missing.exit)).toBe(true);
      expect(missing.stdout).toBe("");
      expect(missing.errors).toContain('There is no conversation "missing" to continue.');
    }),
  );
  it.effect("starts no conversation for an input the Configuration cannot parse", () =>
    Effect.gen(function* () {
      expect((yield* cli(["run", "--config", historyFixture, "first"])).stdout).toBe(
        "heard: first\n",
      );
      const rejected = yield* cli(["run", "--config", historyFixture, "unparseable"]);
      expect(rejected.errors).toContain("Could not parse the input: unparseable input");
      const next = yield* cli(["run", "--config", historyFixture, "--continue", "next"]);
      expect(next.stdout).toBe("heard: first, next\n");
      expect(next.errors).toMatch(/Continued conversation \S+ \(1 Entry\)\./);
    }),
  );
});

describe("mitome providers and auth", () => {
  it.effect("lists Providers and offline credential status without acquiring anything", () =>
    Effect.gen(function* () {
      const providers = yield* cli(["providers", "--config", fixture]);
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
      const missing = yield* cli(["auth", "status", "--config", fixture]);
      expect(missing.logs).toBe(
        [
          "scripted: FIXTURE_API_KEY missing",
          "oauth: auth capability available; credential status unknown",
        ].join("\n"),
      );
      process.env.FIXTURE_API_KEY = "secret-value";
      const present = yield* cli(["auth", "status", "--config", fixture, "--provider", "scripted"]);
      delete process.env.FIXTURE_API_KEY;
      expect(present.logs).toBe("scripted: FIXTURE_API_KEY present");
      expect(present.logs).not.toContain("secret-value");
      expect(yield* events).toEqual([]);
    }),
  );

  it.effect("delegates login and logout to the selected Provider's capability", () =>
    Effect.gen(function* () {
      const ambiguous = yield* cli(["auth", "login", "--config", fixture]);
      expect(Exit.isFailure(ambiguous.exit)).toBe(true);
      expect(ambiguous.errors).toContain("Choose a Provider with --provider: scripted, oauth");

      // No shell snippet: the right one depends on the shell and how mitome is started.
      const explained = {
        login:
          "scripted reads its API key from FIXTURE_API_KEY. Set it in the environment that runs mitome; Mitome does not store it.",
        logout:
          "scripted reads its API key from FIXTURE_API_KEY. Remove it from the environment that runs mitome; Mitome does not store it.",
      };
      for (const operation of ["login", "logout"] as const) {
        const environment = yield* cli([
          "auth",
          operation,
          "--config",
          fixture,
          "--provider",
          "scripted",
        ]);
        expect(Exit.isSuccess(environment.exit)).toBe(true);
        expect(environment.logs).toBe(explained[operation]);
      }

      for (const operation of ["login", "logout"]) {
        const result = yield* cli(["auth", operation, "--config", fixture, "--provider", "oauth"]);
        expect(Exit.isSuccess(result.exit)).toBe(true);
      }
      // Only the capability ran, against the state directory MITOME_HOME places.
      expect(yield* events).toEqual([`auth:login:${home}`, `auth:logout:${home}`]);
    }),
  );

  it.effect("refuses an auth capability that does not return an Effect", () =>
    Effect.gen(function* () {
      const config = join(directory, "promised.ts");
      yield* Effect.promise(async () => {
        await writeFile(
          join(directory, "promised-auth.ts"),
          "export const authenticate = async () => {};\n",
        );
        await writeFile(
          config,
          'export default { protocol: "mitome/1", discovery: [{ id: "promised", modelIds: [], models: {}, credential: { capability: { module: "./promised-auth.ts" } } }], text: { parse: () => 1, render: () => 1 }, acquire: () => 1 };\n',
        );
      });
      const result = yield* cli(["auth", "login", "--config", config]);
      expect(Exit.isFailure(result.exit)).toBe(true);
      expect(result.errors).toContain(
        "The promised auth capability's authenticate did not return an Effect",
      );
    }),
  );

  it.effect("gives an auth capability one line of standard input per read, then undefined", () =>
    Effect.gen(function* () {
      const config = join(directory, "reading.ts");
      yield* Effect.promise(async () => {
        await writeFile(
          join(directory, "reading-auth.ts"),
          `import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))};\nexport const authenticate = ({ input }) => Effect.flatMap(Effect.all([input, input, input, input]), (lines) => Effect.fail(new Error(JSON.stringify(lines))));\n`,
        );
        await writeFile(
          config,
          'export default { protocol: "mitome/1", discovery: [{ id: "reading", modelIds: [], models: {}, credential: { capability: { module: "./reading-auth.ts" } } }], text: { parse: () => 1, render: () => 1 }, acquire: () => 1 };\n',
        );
      });
      // A CRLF split between two chunks ends one line.
      const result = yield* cli(["auth", "login", "--config", config], {
        stdin: Stream.concat(stdin("first\r"), stdin("\nsecond")),
      });
      expect(result.errors).toContain('reading login failed: ["first","second",null,null]');
      expect(result.stdout).toBe("");
    }),
  );

  it.live("interrupts the capability when mitome auth login is interrupted", () =>
    Effect.gen(function* () {
      process.env.MITOME_FIXTURE_AUTH_HOLD = "1";
      const login = yield* Effect.forkChild(
        cli(["auth", "login", "--config", fixture, "--provider", "oauth"]).pipe(
          Effect.ensuring(Effect.sync(() => delete process.env.MITOME_FIXTURE_AUTH_HOLD)),
        ),
      );
      while ((yield* events).length === 0) yield* Effect.sleep("10 millis");
      yield* Fiber.interrupt(login);
      expect(yield* events).toEqual([`auth:login:${home}`, "auth:interrupted"]);
    }),
  );

  it.effect(
    "shares stored logins across Configurations in the state directory, not the config directory",
    () =>
      Effect.gen(function* () {
        const variables = ["MITOME_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const;
        const saved = variables.map((name) => process.env[name]);
        const restore = Effect.sync(() =>
          variables.forEach((name, index) => {
            const value = saved[index];
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
          }),
        );
        delete process.env.MITOME_HOME;
        process.env.XDG_CONFIG_HOME = join(directory, "xdg-config");
        process.env.XDG_STATE_HOME = join(directory, "xdg-state");
        const state = join(directory, "xdg-state", "mitome");
        const marker = join(state, "fixture-login");
        // Logged in through one Configuration and out through another, whose capability module is
        // relative to its own file rather than to this invocation directory.
        const [login, loggedIn, logout] = yield* Effect.all([
          cli(["auth", "login", "--config", fixture, "--provider", "oauth"]),
          Effect.sync(() => existsSync(marker)),
          cli(["auth", "logout", "--config", relativeFixture, "--provider", "oauth"]),
        ]).pipe(Effect.ensuring(restore));
        expect(Exit.isSuccess(login.exit)).toBe(true);
        expect(loggedIn).toBe(true);
        expect(Exit.isSuccess(logout.exit)).toBe(true);
        expect(existsSync(marker)).toBe(false);
        expect(existsSync(join(directory, "xdg-config"))).toBe(false);
        expect(yield* events).toEqual([`auth:login:${state}`, `auth:logout:${state}`]);
      }),
  );
});
