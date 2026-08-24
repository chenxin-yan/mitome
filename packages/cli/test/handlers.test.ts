import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option, Runtime } from "effect";
import { TestConsole } from "effect/testing";
import { afterEach, beforeEach, vi } from "vitest";
import corePackage from "@mitome/core/package.json" with { type: "json" };

import { ChildHost, type ProviderAuthentication } from "../src/child-host-service.ts";
import { runAuth } from "../src/commands/auth.ts";
import { updateConfigEnv } from "../src/config.ts";
import { runInit } from "../src/commands/init.ts";
import { runInstall, runPrompt } from "../src/commands/run.ts";
import { Prompter, type PromptChoice } from "../src/prompter.ts";

type PromptAnswer =
  | { readonly type: "select"; readonly index: number }
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "password"; readonly value: string }
  | { readonly type: "abort" };

type ChildHostCalls = {
  readonly runHost: Array<{
    readonly path: string;
    readonly prompt: string | undefined;
    readonly mode: "auto" | "print";
  }>;
  readonly install: Array<string>;
  readonly removeDependency: Array<{ readonly path: string; readonly packageName: string }>;
  readonly inspect: Array<string>;
  readonly oauth: Array<{
    readonly path: string;
    readonly providerId: string;
    readonly command: "login" | "logout";
  }>;
};

const temporaryDirectories: Array<string> = [];
let previousMitomeHome: string | undefined;

const temporaryDirectory = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "mitome-handlers-"));
  temporaryDirectories.push(path);
  return path;
};

const definition = async (path: string, runtime = true): Promise<string> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "export default {};\n");
  if (runtime) {
    const core = join(dirname(path), "node_modules", "@mitome", "core");
    await mkdir(core, { recursive: true });
    await writeFile(
      join(core, "package.json"),
      JSON.stringify({
        name: "@mitome/core",
        version: corePackage.version,
        exports: { "./package.json": "./package.json" },
      }),
    );
  }
  return path;
};

const fakeChildHost = (
  options: {
    readonly runExitCode?: number;
    readonly installExitCode?: number;
    readonly installRuntime?: boolean;
    readonly authentications?: ReadonlyArray<ProviderAuthentication> | undefined;
  } = {},
) => {
  const calls: ChildHostCalls = {
    runHost: [],
    install: [],
    removeDependency: [],
    inspect: [],
    oauth: [],
  };
  return {
    calls,
    layer: Layer.succeed(ChildHost, {
      runHost: (path, prompt, mode) =>
        Effect.sync(() => {
          calls.runHost.push({ path, prompt, mode });
          return options.runExitCode ?? 0;
        }),
      install: (path) =>
        Effect.promise(async () => {
          calls.install.push(path);
          if (options.installRuntime === true) {
            const core = join(dirname(path), "node_modules", "@mitome", "core");
            await mkdir(core, { recursive: true });
            await writeFile(
              join(core, "package.json"),
              JSON.stringify({ name: "@mitome/core", version: corePackage.version }),
            );
          }
          return options.installExitCode ?? 0;
        }),
      removeDependency: (path, packageName) =>
        Effect.sync(() => {
          calls.removeDependency.push({ path, packageName });
          return 0;
        }),
      listExports: () => Effect.succeed([]),
      inspectExtensions: () => Effect.succeed({ exitCode: 0, extensions: [] }),
      inspectProviderAuthentication: (path) =>
        Effect.sync(() => {
          calls.inspect.push(path);
          return options.authentications ?? [];
        }),
      runOAuthAuth: (path, providerId, command) =>
        Effect.sync(() => {
          calls.oauth.push({ path, providerId, command });
        }),
    }),
  };
};

const fakePrompter = (answers: ReadonlyArray<PromptAnswer> = [], canPrompt = true) => {
  const remaining = [...answers];
  const next = <Type extends PromptAnswer["type"]>(
    type: Type,
  ): Extract<PromptAnswer, { readonly type: Type | "abort" }> => {
    const answer = remaining.shift();
    if (answer === undefined) throw new Error(`Unexpected ${type} prompt`);
    if (answer.type !== type && answer.type !== "abort") {
      throw new Error(`Expected ${answer.type} prompt, received ${type}`);
    }
    // SAFETY: The checks above narrow the queued answer to the requested variant or abort.
    return answer as Extract<PromptAnswer, { readonly type: Type | "abort" }>;
  };
  return Layer.succeed(Prompter, {
    canPrompt: Effect.succeed(canPrompt),
    select: <A>({ choices }: { readonly choices: ReadonlyArray<PromptChoice<A>> }) => {
      const answer = next("select");
      if (answer.type === "abort") return Effect.interrupt;
      return Effect.sync(() => choices.at(answer.index)!.value);
    },
    text: () => {
      const answer = next("text");
      return answer.type === "abort" ? Effect.interrupt : Effect.succeed(answer.value);
    },
    password: () => {
      const answer = next("password");
      return answer.type === "abort" ? Effect.interrupt : Effect.succeed(answer.value);
    },
  });
};

const exitCode = <A, E>(exit: Exit.Exit<A, E>): number => {
  let code = -1;
  Runtime.defaultTeardown(exit, (value) => {
    code = value;
  });
  return code;
};

beforeEach(async () => {
  previousMitomeHome = process.env.MITOME_HOME;
  process.env.MITOME_HOME = await temporaryDirectory();
  vi.stubGlobal("Bun", {
    resolveSync: (_specifier: string, directory: string) => {
      const path = join(directory, "node_modules", "@mitome", "core", "package.json");
      if (!existsSync(path)) throw new Error("not found");
      return path;
    },
    file: (path: string) => ({ text: () => readFile(path, "utf8") }),
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (previousMitomeHome === undefined) delete process.env.MITOME_HOME;
  else process.env.MITOME_HOME = previousMitomeHome;
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("CLI handlers", () => {
  it.effect("selects the default Agent Definition and returns the Child Host exit code", () =>
    Effect.gen(function* () {
      const path = yield* Effect.promise(() =>
        definition(join(process.env.MITOME_HOME!, "index.ts")),
      );
      const childHost = fakeChildHost({ runExitCode: 23 });
      const exit = yield* Effect.exit(
        runPrompt({ print: false, prompt: Option.some("hello"), use: Option.none() }).pipe(
          Effect.provide(Layer.merge(childHost.layer, fakePrompter())),
        ),
      );

      expect(exit).toEqual(Exit.succeed(23));
      expect(childHost.calls.install).toEqual([]);
      expect(childHost.calls.runHost).toEqual([{ path, prompt: "hello", mode: "print" }]);
    }),
  );

  it.effect("rejects a missing forced-print prompt before selecting an Agent Definition", () =>
    Effect.gen(function* () {
      const childHost = fakeChildHost();
      const missing = join(yield* Effect.promise(temporaryDirectory), "missing.ts");
      const exit = yield* Effect.exit(
        runPrompt({ print: true, prompt: Option.none(), use: Option.some(missing) }).pipe(
          Effect.provide(Layer.merge(childHost.layer, fakePrompter())),
        ),
      );

      expect(exitCode(exit)).toBe(1);
      expect((yield* TestConsole.errorLines).join("\n")).toContain("Missing argument prompt");
      expect(childHost.calls.install).toEqual([]);
      expect(childHost.calls.runHost).toEqual([]);
    }),
  );

  it.effect("reconciles a missing runtime before importing the selected Agent Definition", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(temporaryDirectory);
      const path = yield* Effect.promise(() => definition(join(directory, "agent.ts"), false));
      const childHost = fakeChildHost({ installRuntime: true });
      const exit = yield* Effect.exit(
        runPrompt({ print: false, prompt: Option.some("hello"), use: Option.some(path) }).pipe(
          Effect.provide(Layer.merge(childHost.layer, fakePrompter())),
        ),
      );

      expect(exit).toEqual(Exit.succeed(0));
      expect(childHost.calls.install).toEqual([path]);
      expect(childHost.calls.runHost).toEqual([{ path, prompt: "hello", mode: "print" }]);
      expect(yield* TestConsole.logLines).toContain("Installing Mitome Definition dependencies...");
    }),
  );

  it.effect("does not import when automatic reconciliation fails", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(temporaryDirectory);
      const path = yield* Effect.promise(() => definition(join(directory, "agent.ts"), false));
      const childHost = fakeChildHost({ installExitCode: 17 });
      const exit = yield* Effect.exit(
        runPrompt({ print: false, prompt: Option.some("hello"), use: Option.some(path) }).pipe(
          Effect.provide(Layer.merge(childHost.layer, fakePrompter())),
        ),
      );

      expect(exit).toEqual(Exit.succeed(17));
      expect(childHost.calls.install).toEqual([path]);
      expect(childHost.calls.runHost).toEqual([]);
    }),
  );

  it.effect("resolves --use Agent Definition directories and returns installer exit codes", () =>
    Effect.gen(function* () {
      const temporary = yield* Effect.promise(temporaryDirectory);
      const directory = join(temporary, "agent");
      const path = yield* Effect.promise(() => definition(join(directory, "index.ts"), false));
      const childHost = fakeChildHost({ installExitCode: 17 });
      const exit = yield* Effect.exit(
        runInstall({ use: Option.some(directory) }).pipe(
          Effect.provide(Layer.merge(childHost.layer, fakePrompter())),
        ),
      );

      expect(exit).toEqual(Exit.succeed(17));
      expect(childHost.calls.install).toEqual([path]);
    }),
  );

  it.effect("fails the runtime check before delegating to the Child Host", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(temporaryDirectory);
      const path = yield* Effect.promise(() => definition(join(directory, "agent.ts")));
      const packagePath = join(directory, "node_modules", "@mitome", "core", "package.json");
      const childHost = fakeChildHost();

      for (const contents of ["{", "null"]) {
        yield* Effect.promise(() => writeFile(packagePath, contents));
        const beforeErrors = (yield* TestConsole.errorLines).length;
        const exit = yield* Effect.exit(
          runPrompt({ print: false, prompt: Option.some("hello"), use: Option.some(path) }).pipe(
            Effect.provide(Layer.merge(childHost.layer, fakePrompter())),
          ),
        );
        const errors = (yield* TestConsole.errorLines).slice(beforeErrors).join("\n");

        expect(Exit.isFailure(exit)).toBe(true);
        expect(exitCode(exit)).toBe(1);
        expect(errors).toContain("Could not decode");
        expect(errors).toContain("cause:");
      }
      expect(childHost.calls.runHost).toEqual([]);
    }),
  );

  it.effect("reports every Agent Definition path selection error", () =>
    Effect.gen(function* () {
      const childHost = fakeChildHost();
      const layers = Layer.merge(childHost.layer, fakePrompter());

      const missingDefault = yield* Effect.exit(
        runInstall({ use: Option.none() }).pipe(Effect.provide(layers)),
      );
      expect(exitCode(missingDefault)).toBe(1);
      expect((yield* TestConsole.errorLines).join("\n")).toContain("run mitome init first");
      expect((yield* TestConsole.errorLines).join("\n")).not.toContain(
        "Mitome Definition not found",
      );

      const missingDirectory = yield* Effect.promise(temporaryDirectory);
      const missingPath = join(missingDirectory, "missing.ts");
      const missing = yield* Effect.exit(
        runInstall({ use: Option.some(missingPath) }).pipe(Effect.provide(layers)),
      );
      expect(exitCode(missing)).toBe(1);
      expect((yield* TestConsole.errorLines).join("\n")).toContain(
        `Mitome Definition not found at ${missingPath}`,
      );

      const emptyDirectory = yield* Effect.promise(temporaryDirectory);
      const directory = yield* Effect.exit(
        runInstall({ use: Option.some(emptyDirectory) }).pipe(Effect.provide(layers)),
      );
      expect(exitCode(directory)).toBe(1);
      expect((yield* TestConsole.errorLines).join("\n")).toContain(
        `No Mitome Definition module found at ${join(emptyDirectory, "index.ts")}`,
      );

      const javascriptDirectory = yield* Effect.promise(temporaryDirectory);
      const javascript = join(javascriptDirectory, "agent.js");
      yield* Effect.promise(() => writeFile(javascript, "export default {};\n"));
      const nonTypescript = yield* Effect.exit(
        runInstall({ use: Option.some(javascript) }).pipe(Effect.provide(layers)),
      );
      expect(exitCode(nonTypescript)).toBe(1);
      expect((yield* TestConsole.errorLines).join("\n")).toContain("must be a TypeScript module");
      expect(childHost.calls.install).toEqual([]);
    }),
  );

  it.effect("creates and repairs private config directory permissions", () =>
    Effect.gen(function* () {
      const parent = yield* Effect.promise(temporaryDirectory);
      const created = join(parent, "created");
      const existing = join(parent, "existing");
      yield* Effect.promise(() => mkdir(existing, { mode: 0o755 }));
      yield* Effect.promise(() => chmod(existing, 0o755));

      for (const directory of [created, existing]) {
        process.env.MITOME_HOME = directory;
        yield* Effect.promise(() => updateConfigEnv("OPENAI_API_KEY", "synthetic-secret"));
        expect((yield* Effect.promise(() => stat(directory))).mode & 0o777).toBe(0o700);
        expect((yield* Effect.promise(() => stat(join(directory, ".env")))).mode & 0o777).toBe(
          0o600,
        );
      }
    }),
  );

  it.effect("reconciles before authentication imports the selected Agent Definition", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(temporaryDirectory);
      const path = yield* Effect.promise(() => definition(join(directory, "agent.ts"), false));
      const childHost = fakeChildHost({
        installRuntime: true,
        authentications: [{ id: "openai", credential: "OPENAI_API_KEY" }],
      });
      const exit = yield* Effect.exit(
        runAuth("login", Option.some(path)).pipe(
          Effect.provide(
            Layer.merge(
              childHost.layer,
              fakePrompter([{ type: "password", value: "synthetic-secret" }]),
            ),
          ),
        ),
      );

      expect(exit).toEqual(Exit.succeed(0));
      expect(childHost.calls.install).toEqual([path]);
      expect(childHost.calls.inspect).toEqual([path]);
    }),
  );

  it.effect("auth login and logout preserve unrelated config env lines", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(temporaryDirectory);
      const path = yield* Effect.promise(() => definition(join(directory, "agent.ts")));
      const authentication = [{ id: "openai", credential: "OPENAI_API_KEY" }] as const;
      const childHost = fakeChildHost({ authentications: authentication });
      const envPath = join(process.env.MITOME_HOME!, ".env");
      yield* Effect.promise(() =>
        writeFile(envPath, "# retained\nOTHER=present\nOPENAI_API_KEY=old\n"),
      );
      const login = yield* Effect.exit(
        runAuth("login", Option.some(path)).pipe(
          Effect.provide(
            Layer.merge(
              childHost.layer,
              fakePrompter([{ type: "password", value: "synthetic-secret" }]),
            ),
          ),
        ),
      );
      expect(login).toEqual(Exit.succeed(0));
      expect(yield* Effect.promise(() => readFile(envPath, "utf8"))).toBe(
        "# retained\nOTHER=present\nOPENAI_API_KEY=synthetic-secret\n",
      );

      const logout = yield* Effect.exit(
        runAuth("logout", Option.some(path)).pipe(
          Effect.provide(Layer.merge(childHost.layer, fakePrompter())),
        ),
      );
      expect(logout).toEqual(Exit.succeed(0));
      expect(yield* Effect.promise(() => readFile(envPath, "utf8"))).toBe(
        "# retained\nOTHER=present\n",
      );
      expect(childHost.calls.oauth).toEqual([]);
    }),
  );

  it.effect("auth login and logout delegate an Auth capability Credential descriptor", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(temporaryDirectory);
      const path = yield* Effect.promise(() => definition(join(directory, "agent.ts")));
      const childHost = fakeChildHost({
        authentications: [{ id: "codex", credential: { capability: { module: "fixture-auth" } } }],
      });
      const layers = Layer.merge(childHost.layer, fakePrompter());

      expect(
        yield* Effect.exit(runAuth("login", Option.some(path)).pipe(Effect.provide(layers))),
      ).toEqual(Exit.succeed(0));
      expect(
        yield* Effect.exit(runAuth("logout", Option.some(path)).pipe(Effect.provide(layers))),
      ).toEqual(Exit.succeed(0));
      expect(childHost.calls.oauth).toEqual([
        { path, providerId: "codex", command: "login" },
        { path, providerId: "codex", command: "logout" },
      ]);
    }),
  );

  it.effect("auth selects one of several Providers before requesting its Credential", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(temporaryDirectory);
      const path = yield* Effect.promise(() => definition(join(directory, "agent.ts")));
      const childHost = fakeChildHost({
        authentications: [
          { id: "first", credential: "FIRST_KEY" },
          { id: "second", credential: "SECOND_KEY" },
        ],
      });
      const exit = yield* Effect.exit(
        runAuth("login", Option.some(path)).pipe(
          Effect.provide(
            Layer.merge(
              childHost.layer,
              fakePrompter([
                { type: "select", index: 1 },
                { type: "password", value: "second-secret" },
              ]),
            ),
          ),
        ),
      );

      expect(exit).toEqual(Exit.succeed(0));
      expect(
        yield* Effect.promise(() => readFile(join(process.env.MITOME_HOME!, ".env"), "utf8")),
      ).toBe("SECOND_KEY=second-secret\n");
    }),
  );

  it.effect("auth rejects an empty Credential value", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(temporaryDirectory);
      const path = yield* Effect.promise(() => definition(join(directory, "agent.ts")));
      const childHost = fakeChildHost({
        authentications: [{ id: "openai", credential: "EMPTY_LOGIN_KEY" }],
      });
      const exit = yield* Effect.exit(
        runAuth("login", Option.some(path)).pipe(
          Effect.provide(
            Layer.merge(childHost.layer, fakePrompter([{ type: "password", value: "" }])),
          ),
        ),
      );

      expect(exitCode(exit)).toBe(1);
      expect(yield* TestConsole.errorLines).toContain("Credential value is required.");
      expect(existsSync(join(process.env.MITOME_HOME!, ".env"))).toBe(false);
    }),
  );

  it.effect("auth reports an Agent Definition with no auth-capable Providers", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(temporaryDirectory);
      const path = yield* Effect.promise(() => definition(join(directory, "agent.ts")));
      const childHost = fakeChildHost();
      const exit = yield* Effect.exit(
        runAuth("login", Option.some(path)).pipe(
          Effect.provide(Layer.merge(childHost.layer, fakePrompter())),
        ),
      );

      expect(exitCode(exit)).toBe(1);
      expect(yield* TestConsole.errorLines).toEqual([
        "Agent Definition has no auth-capable Providers.",
      ]);
    }),
  );

  it.effect("auth reports Provider ids when interactive selection is unavailable", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(temporaryDirectory);
      const path = yield* Effect.promise(() => definition(join(directory, "agent.ts")));
      const childHost = fakeChildHost({
        authentications: [
          { id: "first", credential: "FIRST_KEY" },
          { id: "second", credential: "SECOND_KEY" },
        ],
      });
      const exit = yield* Effect.exit(
        runAuth("login", Option.some(path)).pipe(
          Effect.provide(Layer.merge(childHost.layer, fakePrompter([], false))),
        ),
      );

      expect(exitCode(exit)).toBe(1);
      expect((yield* TestConsole.errorLines).join("\n")).toContain(
        "Multiple auth-capable Providers",
      );
      expect((yield* TestConsole.errorLines).join("\n")).toContain("first, second");
    }),
  );

  it.effect("auth rejects a Credential value that Bun's env parser would corrupt", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(temporaryDirectory);
      const path = yield* Effect.promise(() => definition(join(directory, "agent.ts")));
      const childHost = fakeChildHost({
        authentications: [{ id: "openai", credential: "AUTH_REJECT_KEY" }],
      });
      const exit = yield* Effect.exit(
        runAuth("login", Option.some(path)).pipe(
          Effect.provide(
            Layer.merge(childHost.layer, fakePrompter([{ type: "password", value: "has$dollar" }])),
          ),
        ),
      );

      expect(exitCode(exit)).toBe(1);
      expect((yield* TestConsole.errorLines).join("\n")).toContain(
        "set the environment variable directly",
      );
      expect(existsSync(join(process.env.MITOME_HOME!, ".env"))).toBe(false);
    }),
  );

  it.effect("auth logout without a stored Credential is a no-op", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(temporaryDirectory);
      const path = yield* Effect.promise(() => definition(join(directory, "agent.ts")));
      const childHost = fakeChildHost({
        authentications: [{ id: "openai", credential: "LOGOUT_NOOP_KEY" }],
      });
      const exit = yield* Effect.exit(
        runAuth("logout", Option.some(path)).pipe(
          Effect.provide(Layer.merge(childHost.layer, fakePrompter())),
        ),
      );

      expect(exit).toEqual(Exit.succeed(0));
      expect(existsSync(join(process.env.MITOME_HOME!, ".env"))).toBe(false);
    }),
  );

  it.effect("init refuses to clobber any existing scaffold file", () =>
    Effect.gen(function* () {
      const existingFiles = [
        { name: "index.ts", contents: "export default {};\n" },
        { name: "package.json", contents: '{"name":"hand-edited"}\n' },
        { name: "AGENTS.md", contents: "hand-written\n" },
      ] as const;

      for (const existing of existingFiles) {
        const home = yield* Effect.promise(temporaryDirectory);
        process.env.MITOME_HOME = home;
        const path = join(home, existing.name);
        yield* Effect.promise(() => writeFile(path, existing.contents));
        const childHost = fakeChildHost();
        // No scripted answers: the fake throws on any prompt, proving init
        // refuses the clobber before prompting.
        const exit = yield* Effect.exit(
          runInit().pipe(Effect.provide(Layer.merge(childHost.layer, fakePrompter()))),
        );

        expect(exitCode(exit), existing.name).toBe(1);
        expect((yield* TestConsole.errorLines).join("\n"), existing.name).toContain(
          `${path} already exists`,
        );
        expect(yield* Effect.promise(() => readFile(path, "utf8")), existing.name).toBe(
          existing.contents,
        );
        expect(childHost.calls.install, existing.name).toEqual([]);
        if (existing.name !== "index.ts") expect(existsSync(join(home, "index.ts"))).toBe(false);
      }
    }),
  );

  it.effect("init rejects a blank custom Model id before writing the scaffold", () =>
    Effect.gen(function* () {
      const childHost = fakeChildHost();
      const exit = yield* Effect.exit(
        runInit().pipe(
          Effect.provide(
            Layer.merge(
              childHost.layer,
              fakePrompter([
                { type: "select", index: 1 },
                { type: "select", index: -1 },
                { type: "text", value: "   " },
              ]),
            ),
          ),
        ),
      );

      expect(exitCode(exit)).toBe(1);
      expect(yield* TestConsole.errorLines).toContain("Model ID is required.");
      expect(existsSync(join(process.env.MITOME_HOME!, "index.ts"))).toBe(false);
      expect(childHost.calls.install).toEqual([]);
    }),
  );

  it.effect("init trims and writes an accepted custom Model id", () =>
    Effect.gen(function* () {
      const childHost = fakeChildHost({
        authentications: [
          { id: "openai-codex", credential: { capability: { module: "fixture-auth" } } },
        ],
      });
      const exit = yield* Effect.exit(
        runInit().pipe(
          Effect.provide(
            Layer.merge(
              childHost.layer,
              fakePrompter([
                { type: "select", index: 1 },
                { type: "select", index: -1 },
                { type: "text", value: "  private-model  " },
              ]),
            ),
          ),
        ),
      );

      expect(exit).toEqual(Exit.succeed(0));
      expect(
        yield* Effect.promise(() => readFile(join(process.env.MITOME_HOME!, "index.ts"), "utf8")),
      ).toContain('model: "openai-codex/private-model"');
    }),
  );

  it.effect("initializes an Agent Definition, installs it, and authenticates its Provider", () =>
    Effect.gen(function* () {
      const childHost = fakeChildHost({
        authentications: [
          { id: "openai-codex", credential: { capability: { module: "fixture-auth" } } },
        ],
      });
      const exit = yield* Effect.exit(
        runInit().pipe(
          Effect.provide(
            Layer.merge(
              childHost.layer,
              fakePrompter([
                { type: "select", index: 1 },
                { type: "select", index: 0 },
              ]),
            ),
          ),
        ),
      );

      const path = join(process.env.MITOME_HOME!, "index.ts");
      expect(exit).toEqual(Exit.succeed(0));
      expect(yield* Effect.promise(() => readFile(path, "utf8"))).toContain(
        'import { codex } from "@mitome/providers/openai-codex"',
      );
      expect(
        yield* Effect.promise(() => readFile(join(process.env.MITOME_HOME!, "AGENTS.md"), "utf8")),
      ).toBe("You are a helpful Agent.\n");
      expect(childHost.calls.install).toEqual([path]);
      expect(childHost.calls.oauth).toEqual([
        { path, providerId: "openai-codex", command: "login" },
      ]);
    }),
  );

  it.effect("returns the installer exit code without inspecting Provider authentication", () =>
    Effect.gen(function* () {
      const childHost = fakeChildHost({ installExitCode: 9 });
      const exit = yield* Effect.exit(
        runInit().pipe(
          Effect.provide(
            Layer.merge(
              childHost.layer,
              fakePrompter([
                { type: "select", index: 1 },
                { type: "select", index: 0 },
              ]),
            ),
          ),
        ),
      );

      expect(exit).toEqual(Exit.succeed(9));
      expect(childHost.calls.inspect).toEqual([]);
    }),
  );

  it.effect("interrupts with exit code 130 at every init Prompter path", () =>
    Effect.gen(function* () {
      const scenarios: ReadonlyArray<{
        readonly name: string;
        readonly answers: ReadonlyArray<PromptAnswer>;
        readonly authentications?: ReadonlyArray<ProviderAuthentication> | undefined;
      }> = [
        { name: "Provider selection", answers: [{ type: "abort" }] },
        {
          name: "Model selection",
          answers: [{ type: "select", index: 1 }, { type: "abort" }],
        },
        {
          name: "custom Model ID",
          answers: [{ type: "select", index: 1 }, { type: "select", index: -1 }, { type: "abort" }],
        },
        {
          name: "authentication Provider selection",
          answers: [{ type: "select", index: 1 }, { type: "select", index: 0 }, { type: "abort" }],
          authentications: [
            { id: "first", credential: { capability: { module: "first-auth" } } },
            { id: "second", credential: { capability: { module: "second-auth" } } },
          ],
        },
        {
          name: "Credential input",
          answers: [{ type: "select", index: 1 }, { type: "select", index: 0 }, { type: "abort" }],
          authentications: [{ id: "codex", credential: "CODEX_KEY" }],
        },
      ];

      for (const scenario of scenarios) {
        const home = yield* Effect.promise(temporaryDirectory);
        process.env.MITOME_HOME = home;
        const childHost = fakeChildHost({ authentications: scenario.authentications });
        const exit = yield* Effect.exit(
          runInit().pipe(
            Effect.provide(Layer.merge(childHost.layer, fakePrompter(scenario.answers))),
          ),
        );
        expect(exitCode(exit), scenario.name).toBe(130);
      }
    }),
  );
});
