import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, Exit, Layer, Option, Runtime } from "effect";
import { TestConsole } from "effect/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import corePackage from "@mitome/core/package.json" with { type: "json" };

// Vitest cannot parse Bun's `with { type: "text" }` imports in child-host.ts.
vi.mock("../src/hosts/host.ts", () => ({ default: "" }));
vi.mock("../src/hosts/auth-host.ts", () => ({ default: "" }));

import { ChildHost, type ProviderAuthentication } from "../src/child-host.ts";
import { runAuth } from "../src/commands/auth.ts";
import { runInit } from "../src/commands/init.ts";
import { runInstall, runPrompt } from "../src/commands/run.ts";
import { Prompter, type PromptChoice } from "../src/prompter.ts";

type PromptAnswer =
  | { readonly type: "select"; readonly index: number }
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "password"; readonly value: string }
  | { readonly type: "abort" };

type ChildHostCalls = {
  readonly runHost: Array<{ readonly path: string; readonly prompt: string }>;
  readonly install: Array<string>;
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
    readonly authentications?: ReadonlyArray<ProviderAuthentication>;
  } = {},
) => {
  const calls: ChildHostCalls = { runHost: [], install: [], inspect: [], oauth: [] };
  return {
    calls,
    layer: Layer.succeed(ChildHost, {
      runHost: (path, prompt) =>
        Effect.sync(() => {
          calls.runHost.push({ path, prompt });
          return options.runExitCode ?? 0;
        }),
      install: (path) =>
        Effect.sync(() => {
          calls.install.push(path);
          return options.installExitCode ?? 0;
        }),
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
  const next = (type: PromptAnswer["type"]): PromptAnswer => {
    const answer = remaining.shift();
    if (answer === undefined) throw new Error(`Unexpected ${type} prompt`);
    if (answer.type !== type && answer.type !== "abort") {
      throw new Error(`Expected ${answer.type} prompt, received ${type}`);
    }
    return answer;
  };
  const abort = <A>(answer: PromptAnswer, value: () => A): Effect.Effect<A> =>
    answer.type === "abort" ? Effect.interrupt : Effect.sync(value);
  return Layer.succeed(Prompter, {
    canPrompt: Effect.succeed(canPrompt),
    select: <A>({ choices }: { readonly choices: ReadonlyArray<PromptChoice<A>> }) => {
      const answer = next("select");
      return abort(answer, () => choices.at((answer as { readonly index: number }).index)!.value);
    },
    text: () => {
      const answer = next("text");
      return abort(answer, () => (answer as { readonly value: string }).value);
    },
    password: () => {
      const answer = next("password");
      return abort(answer, () => (answer as { readonly value: string }).value);
    },
  });
};

const runResult = <A, E, R>(effect: Effect.Effect<A, E, R>, layers: Layer.Layer<R>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect);
    return { exit, errors: yield* TestConsole.errorLines };
  }).pipe(Effect.provide(Layer.merge(layers, TestConsole.layer)), Effect.runPromise);

const run = async <A, E, R>(effect: Effect.Effect<A, E, R>, layers: Layer.Layer<R>) =>
  (await runResult(effect, layers)).exit;

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
  test("selects the default Agent Definition and returns the Child Host exit code", async () => {
    const path = await definition(join(process.env.MITOME_HOME!, "index.ts"));
    const childHost = fakeChildHost({ runExitCode: 23 });

    const exit = await run(
      runPrompt({ prompt: "hello", use: Option.none() }),
      Layer.merge(childHost.layer, fakePrompter()),
    );

    expect(exit).toEqual(Exit.succeed(23));
    expect(childHost.calls.runHost).toEqual([{ path, prompt: "hello" }]);
  });

  test("resolves --use Agent Definition directories and returns installer exit codes", async () => {
    const directory = join(await temporaryDirectory(), "agent");
    const path = await definition(join(directory, "index.ts"), false);
    const childHost = fakeChildHost({ installExitCode: 17 });

    const exit = await run(
      runInstall({ use: Option.some(directory) }),
      Layer.merge(childHost.layer, fakePrompter()),
    );

    expect(exit).toEqual(Exit.succeed(17));
    expect(childHost.calls.install).toEqual([path]);
  });

  test("fails the runtime check before delegating to the Child Host", async () => {
    const path = await definition(join(await temporaryDirectory(), "agent.ts"), false);
    const childHost = fakeChildHost();

    const exit = await run(
      runPrompt({ prompt: "hello", use: Option.some(path) }),
      Layer.merge(childHost.layer, fakePrompter()),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(exitCode(exit)).toBe(1);
    expect(childHost.calls.runHost).toEqual([]);
  });

  test("reports every Agent Definition path selection error", async () => {
    const childHost = fakeChildHost();
    const layers = Layer.merge(childHost.layer, fakePrompter());

    const missingDefault = await runResult(runInstall({ use: Option.none() }), layers);
    expect(exitCode(missingDefault.exit)).toBe(1);
    expect(missingDefault.errors.join("\n")).toContain("run mitome init first");
    expect(missingDefault.errors.join("\n")).not.toContain("Agent Definition not found");

    const missingPath = join(await temporaryDirectory(), "missing.ts");
    const missing = await runResult(runInstall({ use: Option.some(missingPath) }), layers);
    expect(exitCode(missing.exit)).toBe(1);
    expect(missing.errors.join("\n")).toContain(`Agent Definition not found at ${missingPath}`);

    const emptyDirectory = await temporaryDirectory();
    const directory = await runResult(runInstall({ use: Option.some(emptyDirectory) }), layers);
    expect(exitCode(directory.exit)).toBe(1);
    expect(directory.errors.join("\n")).toContain(
      `No Agent Definition module found at ${join(emptyDirectory, "index.ts")}`,
    );

    const javascript = join(await temporaryDirectory(), "agent.js");
    await writeFile(javascript, "export default {};\n");
    const nonTypescript = await runResult(runInstall({ use: Option.some(javascript) }), layers);
    expect(exitCode(nonTypescript.exit)).toBe(1);
    expect(nonTypescript.errors.join("\n")).toContain("must be a TypeScript module");
    expect(childHost.calls.install).toEqual([]);
  });

  test("auth login and logout preserve unrelated config env lines", async () => {
    const path = await definition(join(await temporaryDirectory(), "agent.ts"));
    const authentication = [{ id: "openai", credential: "OPENAI_API_KEY" }] as const;
    const childHost = fakeChildHost({ authentications: authentication });
    const envPath = join(process.env.MITOME_HOME!, ".env");
    await writeFile(envPath, "# retained\nOTHER=present\nOPENAI_API_KEY=old\n");
    const layers = Layer.merge(
      childHost.layer,
      fakePrompter([{ type: "password", value: "synthetic-secret" }]),
    );

    const login = await run(runAuth("login", Option.some(path)), layers);
    expect(login).toEqual(Exit.succeed(0));
    expect(await readFile(envPath, "utf8")).toBe(
      "# retained\nOTHER=present\nOPENAI_API_KEY=synthetic-secret\n",
    );

    const logout = await run(
      runAuth("logout", Option.some(path)),
      Layer.merge(childHost.layer, fakePrompter()),
    );
    expect(logout).toEqual(Exit.succeed(0));
    expect(await readFile(envPath, "utf8")).toBe("# retained\nOTHER=present\n");
    expect(childHost.calls.oauth).toEqual([]);
  });

  test("auth login and logout delegate an Auth capability Credential descriptor", async () => {
    const path = await definition(join(await temporaryDirectory(), "agent.ts"));
    const childHost = fakeChildHost({
      authentications: [{ id: "codex", credential: { capability: { module: "fixture-auth" } } }],
    });
    const layers = Layer.merge(childHost.layer, fakePrompter());

    expect(await run(runAuth("login", Option.some(path)), layers)).toEqual(Exit.succeed(0));
    expect(await run(runAuth("logout", Option.some(path)), layers)).toEqual(Exit.succeed(0));
    expect(childHost.calls.oauth).toEqual([
      { path, providerId: "codex", command: "login" },
      { path, providerId: "codex", command: "logout" },
    ]);
  });

  test("auth selects one of several Providers before requesting its Credential", async () => {
    const path = await definition(join(await temporaryDirectory(), "agent.ts"));
    const childHost = fakeChildHost({
      authentications: [
        { id: "first", credential: "FIRST_KEY" },
        { id: "second", credential: "SECOND_KEY" },
      ],
    });

    const exit = await run(
      runAuth("login", Option.some(path)),
      Layer.merge(
        childHost.layer,
        fakePrompter([
          { type: "select", index: 1 },
          { type: "password", value: "second-secret" },
        ]),
      ),
    );

    expect(exit).toEqual(Exit.succeed(0));
    expect(await readFile(join(process.env.MITOME_HOME!, ".env"), "utf8")).toBe(
      "SECOND_KEY=second-secret\n",
    );
  });

  test("auth rejects an empty Credential value", async () => {
    const path = await definition(join(await temporaryDirectory(), "agent.ts"));
    const childHost = fakeChildHost({
      authentications: [{ id: "openai", credential: "EMPTY_LOGIN_KEY" }],
    });
    const result = await runResult(
      runAuth("login", Option.some(path)),
      Layer.merge(childHost.layer, fakePrompter([{ type: "password", value: "" }])),
    );

    expect(exitCode(result.exit)).toBe(1);
    expect(result.errors).toContain("Credential value is required.");
    expect(existsSync(join(process.env.MITOME_HOME!, ".env"))).toBe(false);
  });

  test("auth reports an Agent Definition with no auth-capable Providers", async () => {
    const path = await definition(join(await temporaryDirectory(), "agent.ts"));
    const childHost = fakeChildHost();
    const result = await runResult(
      runAuth("login", Option.some(path)),
      Layer.merge(childHost.layer, fakePrompter()),
    );

    expect(exitCode(result.exit)).toBe(1);
    expect(result.errors).toEqual(["Agent Definition has no auth-capable Providers."]);
  });

  test("auth reports Provider ids when interactive selection is unavailable", async () => {
    const path = await definition(join(await temporaryDirectory(), "agent.ts"));
    const childHost = fakeChildHost({
      authentications: [
        { id: "first", credential: "FIRST_KEY" },
        { id: "second", credential: "SECOND_KEY" },
      ],
    });
    const result = await runResult(
      runAuth("login", Option.some(path)),
      Layer.merge(childHost.layer, fakePrompter([], false)),
    );

    expect(exitCode(result.exit)).toBe(1);
    expect(result.errors.join("\n")).toContain("Multiple auth-capable Providers");
    expect(result.errors.join("\n")).toContain("first, second");
  });

  test("auth rejects a Credential value that Bun's env parser would corrupt", async () => {
    const path = await definition(join(await temporaryDirectory(), "agent.ts"));
    const childHost = fakeChildHost({
      authentications: [{ id: "openai", credential: "AUTH_REJECT_KEY" }],
    });
    const result = await runResult(
      runAuth("login", Option.some(path)),
      Layer.merge(childHost.layer, fakePrompter([{ type: "password", value: "has$dollar" }])),
    );

    expect(exitCode(result.exit)).toBe(1);
    expect(result.errors.join("\n")).toContain("set the environment variable directly");
    expect(existsSync(join(process.env.MITOME_HOME!, ".env"))).toBe(false);
  });

  test("auth logout without a stored Credential is a no-op", async () => {
    const path = await definition(join(await temporaryDirectory(), "agent.ts"));
    const childHost = fakeChildHost({
      authentications: [{ id: "openai", credential: "LOGOUT_NOOP_KEY" }],
    });

    expect(
      await run(runAuth("logout", Option.some(path)), Layer.merge(childHost.layer, fakePrompter())),
    ).toEqual(Exit.succeed(0));
    expect(existsSync(join(process.env.MITOME_HOME!, ".env"))).toBe(false);
  });

  test("init refuses to clobber any existing scaffold file", async () => {
    const existingFiles = [
      { name: "index.ts", contents: "export default {};\n" },
      { name: "package.json", contents: '{"name":"hand-edited"}\n' },
      { name: "AGENTS.md", contents: "hand-written\n" },
    ] as const;

    for (const existing of existingFiles) {
      const home = await temporaryDirectory();
      process.env.MITOME_HOME = home;
      const path = join(home, existing.name);
      await writeFile(path, existing.contents);
      const childHost = fakeChildHost();
      // No scripted answers: the fake throws on any prompt, proving init
      // refuses the clobber before prompting.
      const result = await runResult(runInit, Layer.merge(childHost.layer, fakePrompter()));

      expect(exitCode(result.exit), existing.name).toBe(1);
      expect(result.errors.join("\n"), existing.name).toContain(`${path} already exists`);
      expect(await readFile(path, "utf8"), existing.name).toBe(existing.contents);
      expect(childHost.calls.install, existing.name).toEqual([]);
      if (existing.name !== "index.ts") expect(existsSync(join(home, "index.ts"))).toBe(false);
    }
  });

  test("init rejects a blank custom Model id before writing the scaffold", async () => {
    const childHost = fakeChildHost();
    const result = await runResult(
      runInit,
      Layer.merge(
        childHost.layer,
        fakePrompter([
          { type: "select", index: 1 },
          { type: "select", index: -1 },
          { type: "text", value: "   " },
        ]),
      ),
    );

    expect(exitCode(result.exit)).toBe(1);
    expect(result.errors).toContain("Model ID is required.");
    expect(existsSync(join(process.env.MITOME_HOME!, "index.ts"))).toBe(false);
    expect(childHost.calls.install).toEqual([]);
  });

  test("init trims and writes an accepted custom Model id", async () => {
    const childHost = fakeChildHost({
      authentications: [
        { id: "openai-codex", credential: { capability: { module: "fixture-auth" } } },
      ],
    });
    const exit = await run(
      runInit,
      Layer.merge(
        childHost.layer,
        fakePrompter([
          { type: "select", index: 1 },
          { type: "select", index: -1 },
          { type: "text", value: "  private-model  " },
        ]),
      ),
    );

    expect(exit).toEqual(Exit.succeed(0));
    expect(await readFile(join(process.env.MITOME_HOME!, "index.ts"), "utf8")).toContain(
      'model: "openai-codex/private-model"',
    );
  });

  test("initializes an Agent Definition, installs it, and authenticates its Provider", async () => {
    const childHost = fakeChildHost({
      authentications: [
        { id: "openai-codex", credential: { capability: { module: "fixture-auth" } } },
      ],
    });

    const exit = await run(
      runInit,
      Layer.merge(
        childHost.layer,
        fakePrompter([
          { type: "select", index: 1 },
          { type: "select", index: 0 },
        ]),
      ),
    );

    const path = join(process.env.MITOME_HOME!, "index.ts");
    expect(exit).toEqual(Exit.succeed(0));
    expect(await readFile(path, "utf8")).toContain(
      'import { codex } from "@mitome/providers/openai-codex"',
    );
    expect(await readFile(join(process.env.MITOME_HOME!, "AGENTS.md"), "utf8")).toBe(
      "You are a helpful Agent.\n",
    );
    expect(childHost.calls.install).toEqual([path]);
    expect(childHost.calls.oauth).toEqual([{ path, providerId: "openai-codex", command: "login" }]);
  });

  test("returns the installer exit code without inspecting Provider authentication", async () => {
    const childHost = fakeChildHost({ installExitCode: 9 });

    const exit = await run(
      runInit,
      Layer.merge(
        childHost.layer,
        fakePrompter([
          { type: "select", index: 1 },
          { type: "select", index: 0 },
        ]),
      ),
    );

    expect(exit).toEqual(Exit.succeed(9));
    expect(childHost.calls.inspect).toEqual([]);
  });

  test("interrupts with exit code 130 at every init Prompter path", async () => {
    const scenarios: ReadonlyArray<{
      readonly name: string;
      readonly answers: ReadonlyArray<PromptAnswer>;
      readonly authentications?: ReadonlyArray<ProviderAuthentication>;
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
      const home = await temporaryDirectory();
      process.env.MITOME_HOME = home;
      const childHost = fakeChildHost(
        scenario.authentications === undefined ? {} : { authentications: scenario.authentications },
      );
      const exit = await run(runInit, Layer.merge(childHost.layer, fakePrompter(scenario.answers)));
      expect(exitCode(exit), scenario.name).toBe(130);
    }
  });
});
