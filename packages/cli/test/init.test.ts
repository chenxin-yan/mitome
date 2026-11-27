import { execFile } from "node:child_process";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import * as BunPath from "@effect/platform-bun/BunPath";
import * as BunServices from "@effect/platform-bun/BunServices";
import { afterAll, describe, expect, it } from "@effect/vitest";
import type { Cause } from "effect";
import {
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  PlatformError,
  Queue,
  Stdio,
  Terminal,
} from "effect";
import { CliOutput } from "effect/cli";
import { TestConsole } from "effect/testing";
import {
  gitignoreSource,
  knownModelIds,
  pinnedDependencies,
  providerChoices,
} from "create-mitome/template";
import type { ProviderId } from "create-mitome/template";
import { Mitome } from "@mitome/core";
import { TerminalOptions } from "@mitome/core/terminal";
import cliPackage from "../package.json" with { type: "json" };
import { runCli } from "../src/index.ts";
import { Installer } from "../src/init.ts";
import type { InstallerService } from "../src/init.ts";
import { terminalKeys } from "../src/terminal/keys.ts";
import {
  configurationPlan,
  installCommand,
  shellQuote,
  signIn,
  writeConfiguration,
} from "../src/template.ts";
import type { FileMap, Shell } from "../src/template.ts";

const packageDirectory = join(import.meta.dirname, "..");
const catalogEffect = /^ {2}effect: ["']?([^"'\s]+)["']?$/m.exec(
  readFileSync(join(packageDirectory, "../../pnpm-workspace.yaml"), "utf8"),
)?.[1];
const directory = await mkdtemp(join(tmpdir(), "mitome-init-"));
afterAll(() => rm(directory, { recursive: true, force: true }));

let homes = 0;
/** A config directory that does not exist yet, as on a first run. */
const freshHome = () => join(directory, `home-${++homes}`, "mitome");

const files = (path: string) => Effect.promise(() => readdir(path).then((names) => names.sort()));
const contents = (path: string, file: string) =>
  Effect.promise(() => readFile(join(path, file), "utf8"));

const key = (name: string): Terminal.UserInput => ({
  input: Option.none(),
  key: { name, ctrl: false, meta: false, shift: false },
});
const typed = (text: string): Array<Terminal.UserInput> =>
  text.split("").map((character) => ({
    input: Option.some(character),
    key: { name: character, ctrl: false, meta: false, shift: false },
  }));

const noInstall: InstallerService = { install: () => Effect.die("nothing may be installed") };

const providerOf = (id: ProviderId) => providerChoices.find((choice) => choice.id === id)!;
const codexLogin = providerOf("openai-codex").signIn!.command;

/** The shell init writes commands for on this machine. */
const shell: Shell = process.platform === "win32" ? "powershell" : "posix";
/** The install command init prints on this machine: its own executable as Bun. */
const liveInstallCommand = installCommand(shellQuote(process.execPath, shell), shell);

/** What a real install leaves for the packages a Configuration imports, at `version` if given. */
const installPackages = (directory: string, version?: string) =>
  Promise.all(
    Object.entries(pinnedDependencies).map(async ([name, pinned]) => {
      await mkdir(join(directory, "node_modules", name), { recursive: true });
      await writeFile(
        join(directory, "node_modules", name, "package.json"),
        `${JSON.stringify({ name, version: version ?? pinned })}\n`,
      );
    }),
  );

/**
 * `plan`, with `intrude` run just before `index.ts` is written: another process creating it after
 * the writer's emptiness check.
 */
const racing = (plan: FileMap, intrude: () => void): FileMap =>
  new (class extends Map<string, string> {
    override *[Symbol.iterator](): Generator<[string, string], undefined> {
      for (const entry of plan) {
        if (entry[0] === "index.ts") {
          intrude();
        }
        yield entry;
      }
    }
  })(plan);

/**
 * Runs the CLI in-process with `MITOME_HOME` at `home`. With `terminal`, stdin and stdout are
 * terminals and the prompts read `keys`, then see their input end. As on a real terminal, keys
 * typed ahead reach only the first reader; a later read of the input sees it ended.
 */
const init = (
  args: ReadonlyArray<string>,
  options: {
    readonly home: string;
    readonly terminal?: boolean;
    readonly keys?: ReadonlyArray<Terminal.UserInput>;
    readonly installer?: InstallerService;
  },
) =>
  Effect.gen(function* () {
    const input = yield* Queue.make<Terminal.UserInput, Cause.Done>();
    yield* Queue.offerAll(input, options.keys ?? []);
    yield* Queue.end(input);
    const ended = yield* Queue.make<Terminal.UserInput, Cause.Done>();
    yield* Queue.end(ended);
    let reads = 0;
    const displayed: Array<string> = [];
    const terminal = Terminal.make({
      columns: Effect.succeed(80),
      rows: Effect.succeed(24),
      size: Effect.die("unused"),
      readInput: Effect.sync(() => (reads++ === 0 ? input : ended)),
      readLine: Effect.die("unused"),
      display: (text) => Effect.sync(() => void displayed.push(text)),
    });
    const services = Layer.mergeAll(
      BunServices.layer,
      TestConsole.layer,
      CliOutput.layer(CliOutput.defaultFormatter({ colors: false })),
      Stdio.layerTest({
        stdinIsTerminal: Effect.succeed(options.terminal ?? false),
        stdoutIsTerminal: Effect.succeed(options.terminal ?? false),
      }),
      Layer.succeed(Terminal.Terminal, terminal),
    );
    const previous = process.env.MITOME_HOME;
    return yield* Effect.gen(function* () {
      // The test console keeps earlier commands' lines; report only this command's.
      const logged = (yield* TestConsole.logLines).length;
      const errored = (yield* TestConsole.errorLines).length;
      const exit = yield* Effect.acquireUseRelease(
        Effect.sync(() => (process.env.MITOME_HOME = options.home)),
        () => Effect.exit(runCli(["init", ...args])),
        () =>
          Effect.sync(() => {
            if (previous === undefined) {
              delete process.env.MITOME_HOME;
            } else {
              process.env.MITOME_HOME = previous;
            }
          }),
      );
      return {
        exit,
        logs: (yield* TestConsole.logLines).slice(logged).join("\n"),
        errors: (yield* TestConsole.errorLines).slice(errored).join("\n"),
        displayed: displayed.join(""),
      };
    }).pipe(
      Effect.provideService(Installer, options.installer ?? noInstall),
      Effect.provide(services),
    );
  });

describe("mitome init", () => {
  it.effect("refuses a config directory that is not empty, before asking anything", () =>
    Effect.gen(function* () {
      const home = freshHome();
      yield* Effect.promise(async () => {
        await mkdir(home, { recursive: true });
        await writeFile(join(home, "notes.txt"), "hand-written\n");
      });
      // Neither flag and no terminal: the refusal comes first.
      for (const args of [[], ["--provider", "openai", "--model", "gpt-5.6"]]) {
        const result = yield* init(args, { home });
        expect(Exit.isFailure(result.exit)).toBe(true);
        expect(result.errors).toContain(`${home} is not empty`);
        expect(result.errors).toContain("changed nothing");
      }
      expect(yield* files(home)).toEqual(["notes.txt"]);
      expect(yield* contents(home, "notes.txt")).toBe("hand-written\n");
    }),
  );

  it.effect(
    "writes the Configuration of the flags' Provider and Model into the config directory",
    () =>
      Effect.gen(function* () {
        for (const choice of providerChoices) {
          const home = freshHome();
          const model = knownModelIds[choice.id][0]!;
          const result = yield* init(
            ["--provider", choice.id, "--model", ` ${model} `, "--no-install"],
            {
              home,
            },
          );
          expect(Exit.isSuccess(result.exit)).toBe(true);
          const plan = configurationPlan({ provider: choice, model });
          expect(yield* files(home)).toEqual([...plan.keys()].sort());
          for (const [file, expected] of plan) {
            expect(yield* contents(home, file)).toBe(expected);
          }
          expect(result.logs).toBe(
            [
              `Wrote the default Configuration to ${home}. Its dependencies are not installed (--no-install); install them by running this in ${home}:`,
              `  ${liveInstallCommand}`,
              "Then:",
              `  ${signIn(choice, shell)}`,
              // Anthropic takes an API key or a sign-in.
              ...(choice.id === "anthropic"
                ? ["  or sign in instead: mitome auth login --provider anthropic"]
                : []),
              "  mitome",
            ].join("\n"),
          );
        }
      }),
  );

  it.effect("creates a missing config directory private to the user", () =>
    Effect.gen(function* () {
      const home = freshHome();
      const result = yield* init(["--provider", "openai", "--model", "gpt-5.6", "--no-install"], {
        home,
      });
      expect(Exit.isSuccess(result.exit)).toBe(true);
      const { mode } = yield* Effect.promise(() => stat(home));
      // Windows has no POSIX mode bits.
      if (process.platform !== "win32") {
        expect(mode & 0o777).toBe(0o700);
      }
    }),
  );

  it.effect("leaves the mode of an existing empty config directory alone", () =>
    Effect.gen(function* () {
      const home = freshHome();
      yield* Effect.promise(async () => {
        await mkdir(home, { recursive: true });
        await chmod(home, 0o750);
      });
      const result = yield* init(["--provider", "openai", "--model", "gpt-5.6", "--no-install"], {
        home,
      });
      expect(Exit.isSuccess(result.exit)).toBe(true);
      const { mode } = yield* Effect.promise(() => stat(home));
      if (process.platform !== "win32") {
        expect(mode & 0o777).toBe(0o750);
      }
    }),
  );

  it.effect("declares --no-install without an affirmative --install", () =>
    Effect.gen(function* () {
      const help = yield* init(["--help"], { home: freshHome() });
      expect(Exit.isSuccess(help.exit)).toBe(true);
      expect(help.logs).toContain("--no-install");
      expect(help.logs.replaceAll("--no-install", "")).not.toContain("--install");
    }),
  );

  it.effect("rejects an unknown Provider or a blank Model id and writes nothing", () =>
    Effect.gen(function* () {
      for (const [args, message] of [
        [["--provider", "openai-compatible", "--model", "m"], "openai-compatible"],
        [["--provider", "openai", "--model", "   "], "--model needs a Model id."],
      ] as const) {
        const home = freshHome();
        const result = yield* init([...args, "--no-install"], { home });
        expect(Exit.isFailure(result.exit)).toBe(true);
        expect(result.errors).toContain(message);
        expect(existsSync(home)).toBe(false);
      }
    }),
  );

  it.effect("needs a terminal unless both --provider and --model are given", () =>
    Effect.gen(function* () {
      for (const args of [[], ["--provider", "openai"], ["--model", "gpt-5.6"]]) {
        const home = freshHome();
        const result = yield* init([...args, "--no-install"], { home });
        expect(Exit.isFailure(result.exit)).toBe(true);
        expect(result.errors).toContain(
          "mitome init asks for the Provider and Model on a terminal; without one, pass both --provider <id> and --model <id>.",
        );
        expect(existsSync(home)).toBe(false);
      }
    }),
  );

  it.effect("asks for the Provider, then one of its Models, keeping keys typed ahead", () =>
    Effect.gen(function* () {
      const home = freshHome();
      // All three keys arrive before the Model question is shown.
      const result = yield* init(["--no-install"], {
        home,
        terminal: true,
        keys: [key("down"), key("enter"), key("enter")],
      });
      expect(Exit.isSuccess(result.exit)).toBe(true);
      expect(result.displayed).toContain(providerOf("openai-codex").label);
      expect(result.displayed).toContain("Custom model ID");
      const configuration = yield* contents(home, "index.ts");
      expect(configuration).toContain("providers: [codex()],");
      expect(configuration).toContain(
        `model: ${JSON.stringify(`openai-codex/${knownModelIds["openai-codex"][0]}`)},`,
      );
    }),
  );

  it.effect("accepts a trimmed custom Model id after the given Provider", () =>
    Effect.gen(function* () {
      const home = freshHome();
      const result = yield* init(["--provider", "anthropic", "--no-install"], {
        home,
        terminal: true,
        keys: [
          ...knownModelIds.anthropic.map(() => key("down")),
          key("enter"),
          ...typed("  my-model  "),
          key("enter"),
        ],
      });
      expect(Exit.isSuccess(result.exit)).toBe(true);
      expect(yield* contents(home, "index.ts")).toContain('model: "anthropic/my-model",');
    }),
  );

  it.effect("writes nothing when input ends while a question is open", () =>
    Effect.gen(function* () {
      const home = freshHome();
      // The Provider is chosen; input ends at the Model question.
      const result = yield* init(["--no-install"], {
        home,
        terminal: true,
        keys: [key("enter")],
      });
      expect(Exit.isFailure(result.exit)).toBe(true);
      expect(result.displayed).toContain("? Model");
      expect(result.errors).toContain("No Provider and Model were chosen; nothing was written.");
      expect(existsSync(home)).toBe(false);
    }),
  );

  it.effect("asks again for a blank custom Model id and accepts the next one", () =>
    Effect.gen(function* () {
      const home = freshHome();
      const result = yield* init(["--provider", "openai", "--no-install"], {
        home,
        terminal: true,
        keys: [
          ...knownModelIds.openai.map(() => key("down")),
          key("enter"),
          ...typed("   "),
          key("enter"),
          ...typed("my-model"),
          key("enter"),
        ],
      });
      expect(Exit.isSuccess(result.exit)).toBe(true);
      expect(result.displayed).toContain("Model ID is required");
      expect(yield* contents(home, "index.ts")).toContain('model: "openai/my-model",');
    }),
  );

  it.effect("installs the dependencies in the config directory, then prints the next steps", () =>
    Effect.gen(function* () {
      const home = freshHome();
      const installed: Array<{ readonly directory: string; readonly files: Array<string> }> = [];
      const result = yield* init(["--provider", "openai-codex", "--model", "gpt-5.5"], {
        home,
        installer: {
          install: (directory) =>
            Effect.promise(async () => {
              installed.push({ directory, files: await readdir(directory) });
              await installPackages(directory);
            }),
        },
      });
      expect(Exit.isSuccess(result.exit)).toBe(true);
      expect(installed).toEqual([
        { directory: home, files: expect.arrayContaining(["package.json"]) },
      ]);
      expect(result.logs).toBe(
        [
          `Wrote the default Configuration to ${home} and installed its dependencies. Next:`,
          `  ${codexLogin}`,
          "  mitome",
        ].join("\n"),
      );
    }),
  );

  it.effect(
    "finds the packages where a hoisting workspace installed them, above the directory",
    () =>
      Effect.gen(function* () {
        const home = freshHome();
        const result = yield* init(["--provider", "openai", "--model", "gpt-5.6"], {
          home,
          installer: {
            install: (directory) => Effect.promise(() => installPackages(dirname(directory))),
          },
        });
        expect(Exit.isSuccess(result.exit)).toBe(true);
        expect(result.logs).toContain(
          `Wrote the default Configuration to ${home} and installed its dependencies. Next:`,
        );
      }),
  );

  it.effect("finds the hoisted packages from a relative MITOME_HOME in a workspace member", () =>
    Effect.gen(function* () {
      const workspace = dirname(freshHome());
      const member = join(workspace, "member");
      yield* Effect.promise(() => mkdir(member, { recursive: true }));
      const result = yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          const previous = process.cwd();
          process.chdir(member);
          return previous;
        }),
        () =>
          init(["--provider", "openai", "--model", "gpt-5.6"], {
            home: "mitome",
            installer: { install: () => Effect.promise(() => installPackages(workspace)) },
          }),
        (previous) => Effect.sync(() => process.chdir(previous)),
      );
      expect(Exit.isSuccess(result.exit)).toBe(true);
      expect(yield* files(join(member, "mitome"))).toContain("index.ts");
    }),
  );

  it.effect("finds the hoisted packages through a link to a workspace member", () =>
    Effect.gen(function* () {
      const workspace = dirname(freshHome());
      const member = join(workspace, "member");
      const home = join(directory, `link-${homes}`);
      yield* Effect.promise(async () => {
        await mkdir(member, { recursive: true });
        await symlink(member, home, "dir");
      });
      const result = yield* init(["--provider", "openai", "--model", "gpt-5.6"], {
        home,
        installer: { install: () => Effect.promise(() => installPackages(workspace)) },
      });
      expect(Exit.isSuccess(result.exit)).toBe(true);
      expect(yield* files(member)).toContain("index.ts");
    }),
  );

  it.effect("fails when the packages found are not the versions the Configuration pins", () =>
    Effect.gen(function* () {
      const home = freshHome();
      const result = yield* init(["--provider", "openai", "--model", "gpt-5.6"], {
        home,
        installer: {
          install: (directory) =>
            Effect.promise(() => installPackages(dirname(directory), "0.0.1-unrelated")),
        },
      });
      expect(Exit.isFailure(result.exit)).toBe(true);
      const expected = Object.entries(pinnedDependencies)
        .map(([name, pinned]) => `expected ${name}@${pinned}, found 0.0.1-unrelated`)
        .join("; ");
      expect(result.errors).toContain(
        `Wrote the default Configuration to ${home}, but its dependencies are not installed: ${expected}. Install them by running this in ${home}: ${liveInstallCommand}`,
      );
    }),
  );

  it.effect("keeps the files and says how to finish when the install fails", () =>
    Effect.gen(function* () {
      const home = freshHome();
      const result = yield* init(["--provider", "openai", "--model", "gpt-5.6"], {
        home,
        installer: { install: () => Effect.fail("offline") },
      });
      expect(Exit.isFailure(result.exit)).toBe(true);
      expect(result.errors).toContain(
        `Wrote the default Configuration to ${home}, but its dependencies are not installed: offline. Install them by running this in ${home}: ${liveInstallCommand}`,
      );
      expect(result.logs).toBe("");
      expect(yield* files(home)).toEqual(
        [...configurationPlan({ provider: providerOf("openai"), model: "gpt-5.6" }).keys()].sort(),
      );
    }),
  );

  it.effect("fails when the installer succeeds without installing the packages", () =>
    Effect.gen(function* () {
      const home = freshHome();
      const result = yield* init(["--provider", "openai", "--model", "gpt-5.6"], {
        home,
        installer: { install: () => Effect.void },
      });
      expect(Exit.isFailure(result.exit)).toBe(true);
      expect(result.errors).toContain(
        `Wrote the default Configuration to ${home}, but its dependencies are not installed: the installer reported success but installed nothing (a dry-run or skip-install setting). Install them by running this in ${home}: ${liveInstallCommand}`,
      );
      expect(result.logs).toBe("");
      expect(yield* files(home)).toContain("index.ts");
    }),
  );

  it.effect("says how to finish when the install is interrupted", () =>
    Effect.gen(function* () {
      const home = freshHome();
      const result = yield* init(["--provider", "openai", "--model", "gpt-5.6"], {
        home,
        installer: { install: () => Effect.interrupt },
      });
      expect(Exit.hasInterrupts(result.exit)).toBe(true);
      expect(result.errors).toContain(
        `Interrupted: wrote the default Configuration to ${home}, but its dependencies may not be installed. Install them by running this in ${home}: ${liveInstallCommand}`,
      );
      expect(yield* files(home)).toContain("index.ts");
    }),
  );
});

/** Runs `writeConfiguration` with the platform the CLI provides, interrupted if `signal` aborts. */
const runWriteConfiguration = (directory: string, plan: FileMap, signal?: AbortSignal) =>
  Effect.runPromise(writeConfiguration(directory, plan).pipe(Effect.provide(BunServices.layer)), {
    signal,
  });

describe("writeConfiguration", () => {
  const plan = configurationPlan({ provider: providerOf("openai"), model: "gpt-5.6" });

  it("refuses a directory that is not empty", async () => {
    const home = freshHome();
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "index.ts"), "hand-written\n");
    await expect(runWriteConfiguration(home, plan)).rejects.toThrow(`${home} is not empty`);
    expect(await readdir(home)).toEqual(["index.ts"]);
  });

  it("removes what it wrote when index.ts appears after its check, keeping that file", async () => {
    const home = freshHome();
    await mkdir(home, { recursive: true });
    const intruded = racing(plan, () => writeFileSync(join(home, "index.ts"), "hand-written\n"));
    await expect(runWriteConfiguration(home, intruded)).rejects.toThrow(
      `${join(home, "index.ts")} already exists`,
    );
    expect(await readdir(home)).toEqual(["index.ts"]);
    expect(await readFile(join(home, "index.ts"), "utf8")).toBe("hand-written\n");
  });

  it("does not write through a dangling symlink that appears after its check", async () => {
    const home = freshHome();
    const link = join(home, "index.ts");
    const target = join(home, "..", "elsewhere.ts");
    const intruded = racing(plan, () => symlinkSync(target, link));
    await expect(runWriteConfiguration(home, intruded)).rejects.toThrow(`${link} already exists`);
    // The directory it created now holds another process's entry, so it stays with only that.
    expect(await readdir(home)).toEqual(["index.ts"]);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(target);
    expect(existsSync(target)).toBe(false);
  });

  it("removes what it wrote and the directories it created when interrupted between two files", async () => {
    const parent = join(directory, `home-${++homes}`);
    const home = join(parent, "mitome");
    const interruption = new AbortController();
    const interrupted = racing(plan, () => interruption.abort());
    await expect(runWriteConfiguration(home, interrupted, interruption.signal)).rejects.toThrow(
      "All fibers interrupted without error",
    );
    expect(existsSync(parent)).toBe(false);
  });

  const cannotMake = (path: string) =>
    PlatformError.systemError({
      _tag: "NotFound",
      module: "FileSystem",
      method: "makeDirectory",
      cause: new Error(`cannot make ${path}`),
    });

  /** The platform's file system, except that making `refused` fails as a missing path does. */
  const refusing = (refused: (path: string) => boolean) =>
    Layer.effect(
      FileSystem.FileSystem,
      Effect.map(FileSystem.FileSystem, (fs) => ({
        ...fs,
        makeDirectory: (path, options) =>
          refused(path) ? Effect.fail(cannotMake(path)) : fs.makeDirectory(path, options),
      })),
    ).pipe(Layer.provideMerge(BunServices.layer));

  it("removes the directories it created when a deeper one cannot be made", async () => {
    const parent = join(directory, `home-${++homes}`);
    const home = join(parent, "mitome");
    await expect(
      Effect.runPromise(
        writeConfiguration(home, plan).pipe(Effect.provide(refusing((path) => path === home))),
      ),
    ).rejects.toThrow(`cannot make ${home}`);
    expect(existsSync(parent)).toBe(false);
  });

  it("fails when the root of the directory does not exist, as a missing Windows drive", async () => {
    const asked: Array<string> = [];
    // No drive Z, whatever the host has: nothing exists there and nothing can be made.
    const missingDrive = Layer.effect(
      FileSystem.FileSystem,
      Effect.map(FileSystem.FileSystem, (fs) => ({
        ...fs,
        exists: () => Effect.succeed(false),
        readDirectory: (path) => Effect.fail(cannotMake(path)),
        makeDirectory: (path) =>
          Effect.suspend(() => {
            asked.push(path);
            return Effect.fail(cannotMake(path));
          }),
      })),
    ).pipe(Layer.provideMerge(BunServices.layer));
    await expect(
      Effect.runPromise(
        writeConfiguration(String.raw`Z:\mitome`, plan).pipe(
          Effect.provide(Layer.merge(missingDrive, BunPath.layerWin32)),
          // Without an end to the walk up, this never returns.
          Effect.timeout("2 seconds"),
        ),
      ),
    ).rejects.toThrow("cannot make Z:\\");
    expect(asked).toEqual(["Z:\\"]);
  });

  it("removes the directories it created when a file cannot be written", async () => {
    const parent = join(directory, `home-${++homes}`);
    const home = join(parent, "mitome");
    // The last file's directory does not exist, so creating it fails after the others are written.
    const failing = new Map([...plan, ["missing/index.ts", ""]]);
    await expect(runWriteConfiguration(home, failing)).rejects.toThrow("ENOENT");
    expect(existsSync(home)).toBe(false);
    expect(existsSync(parent)).toBe(false);
  });
});

describe("Configuration plans", () => {
  it("defines the Agent, its Configuration and project files as plan data", () => {
    const plan = configurationPlan({ provider: providerOf("openai"), model: "gpt-5.6" });

    expect(new Set(plan.keys())).toEqual(
      new Set(["package.json", "agent.ts", "index.ts", "tsconfig.json", ".gitignore", "README.md"]),
    );
    expect(JSON.parse(plan.get("package.json")!)).toEqual({
      name: "mitome-agent",
      private: true,
      type: "module",
      dependencies: {
        "@mitome/core": cliPackage.version,
        "@mitome/providers": cliPackage.version,
        effect: catalogEffect,
      },
    });
    expect(plan.get(".gitignore")).toBe(gitignoreSource);
    const readme = plan.get("README.md")!;
    expect(readme).toContain("default Configuration");
    expect(readme).toContain("Keep it in Git");
    expect(readme).toContain('export OPENAI_API_KEY="your key"');
    expect(readme).toContain('$env:OPENAI_API_KEY = "your key"');
    expect(readme).toContain('mitome run "Roll a die."');
    expect(readme).toContain("denied in `mitome run`");
    expect(readme).toContain("`BUN_BE_BUN=1 mitome install`");
    expect(readme).toContain(
      '`$env:BUN_BE_BUN = "1"; & mitome install; Remove-Item Env:BUN_BE_BUN`',
    );
    const codexReadme = configurationPlan({ provider: providerOf("openai-codex"), model: "m" }).get(
      "README.md",
    )!;
    expect(codexReadme).toContain(codexLogin);
    expect(codexReadme).not.toContain("OPENAI_API_KEY");
    const anthropicReadme = configurationPlan({
      provider: providerOf("anthropic"),
      model: "claude-sonnet-5",
    }).get("README.md")!;
    expect(anthropicReadme).toContain('export ANTHROPIC_API_KEY="your key"');
    expect(anthropicReadme).toContain(
      "Or sign in instead; an API key in the environment takes precedence:\n\n```sh\nmitome auth login --provider anthropic\n```",
    );
    expect(readme).not.toContain("Or sign in instead");
    // `ant` keeps Anthropic's sign-in; Mitome's state directory and auth.json play no part in it.
    expect(anthropicReadme).not.toContain("auth.json");
    expect(anthropicReadme).not.toContain("Mitome's state directory");
    expect(anthropicReadme).toContain(
      "Mitome uses `ant`'s profile, not a separate Mitome credential store, and the sign-in is not kept here: Anthropic's CLI, `ant`, owns it and keeps it in its `mitome` profile, in Anthropic's config directory (`ANTHROPIC_CONFIG_DIR` if set; otherwise `$XDG_CONFIG_HOME/anthropic` or `~/.config/anthropic`, and on Windows `%APPDATA%\\Anthropic` or `%USERPROFILE%\\AppData\\Roaming\\Anthropic`).",
    );
    expect(readme).toContain("Logins are stored in Mitome's state directory");
  });

  it("writes commands for the user's shell", () => {
    expect(shellQuote("/usr/local/bin/mitome", "posix")).toBe("/usr/local/bin/mitome");
    expect(shellQuote("/opt/my tools/it's/mitome", "posix")).toBe(
      String.raw`'/opt/my tools/it'\''s/mitome'`,
    );
    expect(shellQuote(String.raw`C:\Program Files\it's\mitome.exe`, "powershell")).toBe(
      String.raw`'C:\Program Files\it''s\mitome.exe'`,
    );
    // PowerShell also ends a single-quoted string at a typographic single quote.
    expect(shellQuote("C:\\Users\\O\u2018\u2019\u201a\u201bBrien\\mitome.exe", "powershell")).toBe(
      "'C:\\Users\\O\u2018\u2018\u2019\u2019\u201a\u201a\u201b\u201bBrien\\mitome.exe'",
    );
    expect(installCommand("'/opt/my tools/mitome'", "posix")).toBe(
      "BUN_BE_BUN=1 '/opt/my tools/mitome' install",
    );
    expect(installCommand(String.raw`'C:\mitome.exe'`, "powershell")).toBe(
      String.raw`$env:BUN_BE_BUN = "1"; & 'C:\mitome.exe' install; Remove-Item Env:BUN_BE_BUN`,
    );
    expect(signIn(providerOf("openai"), "posix")).toBe('export OPENAI_API_KEY="your key"');
    expect(signIn(providerOf("anthropic"), "powershell")).toBe(
      '$env:ANTHROPIC_API_KEY = "your key"',
    );
    expect(signIn(providerOf("openai-codex"), "powershell")).toBe(codexLogin);
  });
});

describe("generated TypeScript", () => {
  const providers = [
    ["openai", "gpt-5.6"],
    ["openai-codex", "gpt-5.6"],
    ["anthropic", "claude-sonnet-5"],
  ] as const;

  const generated = async () => {
    const root = await mkdtemp(join(directory, "generated-"));
    // Generated Configurations resolve @mitome/core, @mitome/providers and effect like an installed one
    // would; this package's devDependencies stand in for the install.
    await symlink(join(packageDirectory, "node_modules"), join(root, "node_modules"), "dir");
    for (const [provider, model] of providers) {
      await runWriteConfiguration(
        join(root, provider),
        configurationPlan({ provider: providerOf(provider), model }),
      );
    }
    return root;
  };

  it(
    "every Provider variant typechecks against the workspace packages",
    { tags: ["dist"], timeout: 60_000 },
    async () => {
      const root = await generated();
      // One program over every generated module, using the tsconfig a Configuration ships with.
      await writeFile(
        join(root, "tsconfig.json"),
        configurationPlan({ provider: providerOf("openai"), model: "gpt-5.6" }).get(
          "tsconfig.json",
        )!,
      );

      const tsc = promisify(execFile)(join(packageDirectory, "node_modules/.bin/tsc"), [
        "-p",
        join(root, "tsconfig.json"),
      ]);
      await expect(tsc).resolves.toMatchObject({ stdout: "" });
    },
  );

  it("every Provider variant default-exports a Configuration of its Model", async () => {
    const root = await generated();
    for (const [provider, model] of providers) {
      const generated: { readonly default: object } = await import(
        pathToFileURL(join(root, provider, "index.ts")).href
      );
      expect(generated.default).toMatchObject({
        protocol: Mitome.protocol,
        model: `${provider}/${model}`,
        discovery: [{ id: provider }],
        agent: { use: [{ name: "dice" }] },
      });
      expect(generated.default).toHaveProperty(
        ["agent", "use", 0, "parts", "tools", "tools", "roll", "needsApproval"],
        true,
      );
    }
  });

  it("every Provider variant gives the terminal the starter keys, which it opens with", async () => {
    const root = await generated();
    for (const [provider] of providers) {
      const path = join(root, provider, "index.ts");
      expect(await readFile(path, "utf8")).toContain(
        [
          "  provide: terminal({",
          "    keys: {",
          "      enter: terminal.submit,",
          '      "shift+enter": terminal.newline,',
          '      "ctrl+j": terminal.newline,',
          "      escape: terminal.interrupt,",
          '      "ctrl+d": "/quit",',
          "    },",
          "  }),",
          "});",
        ].join("\n"),
      );
      const generated: { readonly default: { readonly provide: Layer.Layer<never> } } =
        await import(pathToFileURL(path).href);
      const keys = await Effect.runPromise(
        Effect.map(TerminalOptions, (options) => options).pipe(
          Effect.provide(generated.default.provide),
          Effect.flatMap((options) => terminalKeys(options, path)),
        ),
      );
      expect([...keys.keys()]).toEqual(["enter", "shift+enter", "ctrl+j", "escape", "ctrl+d"]);
    }
  });
});
