import { spawn as spawnChild } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { text } from "node:stream/consumers";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { knownModelIds as codexModelIds } from "@mitome/providers/openai-codex";
import { knownModelIds as openAiModelIds } from "@mitome/providers/openai";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binary = join(packageDir, "dist/local/mitome");
const coreDir = resolve(packageDir, "../core");
const effectDir = dirname(createRequire(import.meta.url).resolve("effect/package.json"));
const aiOpenaiDir = dirname(
  createRequire(join(packageDir, "..", "providers", "package.json")).resolve(
    "@effect/ai-openai/package.json",
  ),
);
const cliPackage = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as {
  version: string;
};
const corePackage = JSON.parse(await readFile(join(coreDir, "package.json"), "utf8")) as {
  version: string;
};
const effectPackage = JSON.parse(await readFile(join(effectDir, "package.json"), "utf8")) as {
  version: string;
  exports: Record<string, string>;
};
const temporaryDirectories: Array<string> = [];

const promptEchoDefinitionSource = (): string => `
import { Layer, Stream } from "effect";
import { LanguageModel, Response } from "effect/unstable/ai";
import { makeModel } from "@mitome/core";

const model = makeModel(Layer.succeed(LanguageModel.LanguageModel, {
  streamText: () => Stream.succeed(Response.makePart("text-delta", {
    id: "prompt", delta: process.argv[2]!,
  })),
}));
export default { model, plugins: [] };
`;

const definitionSource = (
  output: string,
  options: {
    readonly block?: boolean;
    readonly signalProbe?: {
      readonly pid: string;
      readonly cleanupStarted: string;
      readonly cleanupDone: string;
    };
  } = {},
): string => `
import { writeFileSync } from "node:fs";
import { Effect, Layer, Stream } from "effect";
import { LanguageModel, Response } from "effect/unstable/ai";
import { makeModel } from "@mitome/core";

${options.signalProbe ? `writeFileSync(${JSON.stringify(options.signalProbe.pid)}, String(process.pid));` : ""}
interface FixtureOutput { readonly text: string }
const fixture: FixtureOutput = { text: ${JSON.stringify(output)} };
const model = makeModel(Layer.succeed(LanguageModel.LanguageModel, {
  streamText: () => Stream.concat(
    Stream.succeed(Response.makePart("text-delta", { id: "first", delta: fixture.text })),
    ${options.block ? 'Stream.fromEffect(Effect.sleep(10_000).pipe(Effect.as(Response.makePart("text-delta", { id: "second", delta: " second" }))))' : 'Stream.fromEffect(Effect.sleep(100).pipe(Effect.as(Response.makePart("text-delta", { id: "second", delta: " second" }))))'},
  ),
}));
export default { model, plugins: ${
  options.signalProbe
    ? `[{ name: "cleanup", hooks: { sessionEnd: Effect.sync(() => {
      writeFileSync(${JSON.stringify(options.signalProbe.cleanupStarted)}, "");
      // Keep cleanup in progress while the test delivers the duplicate SIGINT.
      const cleanupUntil = Date.now() + 100;
      while (Date.now() < cleanupUntil) {}
      writeFileSync(${JSON.stringify(options.signalProbe.cleanupDone)}, "");
    }) } }]`
    : "[]"
} };
`;

const envDefinitionSource = (): string => `
import { Layer, Stream } from "effect";
import { LanguageModel, Response } from "effect/unstable/ai";
import { makeModel } from "@mitome/core";

const model = makeModel(Layer.succeed(LanguageModel.LanguageModel, {
  streamText: () => Stream.succeed(Response.makePart("text-delta", {
    id: "env",
    delta: [
      process.env.OPENAI_API_KEY ?? "missing",
      process.env.QUOTED_VALUE ?? "missing",
      process.env.PROBE_ONLY_CWD ?? "absent",
    ].join(":"),
  })),
}));
export default { model, plugins: [] };
`;

const precedenceDefinitionSource = (name: string): string => `
import { Layer, Stream } from "effect";
import { LanguageModel, Response } from "effect/unstable/ai";
import { makeModel } from "@mitome/core";

const model = makeModel(Layer.succeed(LanguageModel.LanguageModel, {
  streamText: () => Stream.succeed(Response.makePart("text-delta", {
    id: "credential", delta: process.env[${JSON.stringify(name)}] ?? "missing",
  })),
}), ${JSON.stringify(name)});
export default { model, plugins: [] };
`;

const approvalDefinitionSource = (marker: string): string => `
import { writeFileSync } from "node:fs";
import { Effect, Layer, Schema, Stream } from "effect";
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai";
import { makeModel } from "@mitome/core";

let calls = 0;
const model = makeModel(Layer.effect(LanguageModel.LanguageModel, LanguageModel.make({
  generateText: () => Effect.succeed([]),
  streamText: () => {
    calls += 1;
    if (calls === 1) return Stream.succeed({
      type: "tool-call", id: "call-approval", name: "dangerous", params: { action: "delete" },
    });
    return Stream.succeed({ type: "text-delta", id: "done", delta: "continued" });
  },
})));
const dangerous = Tool.make("dangerous", {
  parameters: Schema.Struct({ action: Schema.String }),
  success: Schema.String,
  needsApproval: true,
});
export default {
  model,
  plugins: [{
    name: "dangerous",
    toolkit: Toolkit.make(dangerous),
    handlers: { dangerous: () => Effect.sync(() => { writeFileSync(${JSON.stringify(marker)}, "ran"); return "ran"; }) },
  }],
};
`;

type Fixture = {
  readonly root: string;
  readonly definition: string;
  readonly env: {
    readonly HOME: string;
    readonly XDG_CONFIG_HOME: string;
    readonly PATH: string;
  };
};

const scaffold = async (prefix: string): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  const emptyPath = join(root, "empty-path");
  await mkdir(emptyPath);
  return {
    root,
    definition: join(root, "definition", "agent.ts"),
    env: {
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: join(root, "xdg"),
      PATH: emptyPath,
    },
  };
};

const cachedModelHints = async (current: Fixture): Promise<void> => {
  const config = join(current.env.XDG_CONFIG_HOME, "mitome");
  await mkdir(config, { recursive: true });
  await writeFile(
    join(config, "models-cache.json"),
    `${JSON.stringify({ openai: openAiModelIds, "openai-codex": codexModelIds, fetchedAt: Date.now() })}\n`,
  );
};

const fixture = async (source = definitionSource("first")): Promise<Fixture> => {
  const current = await scaffold("mitome-cli-");
  const nodeModules = join(dirname(current.definition), "node_modules");
  const core = join(nodeModules, "@mitome", "core");
  await mkdir(core, { recursive: true });
  await writeFile(current.definition, source);
  await cp(join(coreDir, "dist"), join(core, "dist"), { recursive: true });
  await cp(join(coreDir, "package.json"), join(core, "package.json"));
  await symlink(effectDir, join(nodeModules, "effect"), "dir");
  return current;
};

const installFixture = async (options: { readonly core?: boolean } = {}): Promise<Fixture> => {
  const current = await scaffold("mitome-install-");
  const definition = current.definition;
  const definitionDirectory = dirname(definition);
  const packages = join(current.root, "pkgs");
  const marker = join(current.root, "definition-ran");
  await mkdir(join(packages, "local-dep"), { recursive: true });
  await writeFile(
    join(packages, "local-dep", "package.json"),
    JSON.stringify({ name: "local-dep", version: "1.0.0" }),
  );
  await writeFile(join(packages, "local-dep", "index.js"), 'export default "installed";\n');
  await mkdir(definitionDirectory, { recursive: true });
  await writeFile(
    definition,
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");`,
  );

  const dependencies: Record<string, string> = { "local-dep": "file:../pkgs/local-dep" };
  if (options.core) {
    const core = join(packages, "core");
    await cp(join(coreDir, "dist"), join(core, "dist"), { recursive: true });
    // The real core package.json declares "effect": "catalog:", which bun
    // install cannot resolve outside the workspace; write a minimal stand-in.
    await writeFile(
      join(core, "package.json"),
      JSON.stringify({
        name: "@mitome/core",
        version: corePackage.version,
        exports: { ".": "./dist/index.js" },
      }),
    );
    dependencies["@mitome/core"] = "file:../pkgs/core";
  }
  await writeFile(
    join(definitionDirectory, "package.json"),
    JSON.stringify({ name: "definition", private: true, dependencies }),
  );
  return current;
};

const spawn = (
  input: string | undefined,
  args: ReadonlyArray<string>,
  current: Fixture,
  env: Record<string, string> = current.env,
) => {
  const child = spawnChild(binary, args, {
    cwd: current.root,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (input !== undefined) child.stdin.end(input);
  return child;
};

const exited = (child: ReturnType<typeof spawnChild>) => {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  const events = child as unknown as {
    once(event: "error", listener: (error: Error) => void): void;
    once(event: "close", listener: (code: number | null) => void): void;
  };
  return new Promise<number | null>((resolve, reject) => {
    events.once("error", reject);
    events.once("close", resolve);
  });
};

const output = async (child: ReturnType<typeof spawn>) => {
  const [stdout, stderr, exitCode] = await Promise.all([
    text(child.stdout),
    text(child.stderr),
    exited(child),
  ]);
  return { stdout, stderr, exitCode };
};

type StdoutReader = AsyncIterator<string>;

const rest = async (reader: StdoutReader) => {
  let output = "";
  for (let next = await reader.next(); !next.done; next = await reader.next()) {
    output += next.value;
  }
  return output;
};

const exists = async (path: string) => {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

beforeAll(async () => {
  if (!(await exists(binary))) {
    throw new Error("Build @mitome/cli before running its subprocess tests");
  }
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("compiled mitome", () => {
  test("supports native help, version, and completions without command side effects", async () => {
    const current = await scaffold("mitome-native-actions-");

    const help = await output(spawn("", ["--help"], current));
    expect(help).toMatchObject({ exitCode: 0, stderr: "" });
    expect(help.stdout).toContain("USAGE\n  mitome");

    expect(await output(spawn("", ["--version"], current))).toMatchObject({
      exitCode: 0,
      stdout: `mitome v${cliPackage.version}\n`,
      stderr: "",
    });

    const completions = await output(spawn("", ["--completions", "bash"], current));
    expect(completions).toMatchObject({ exitCode: 0, stderr: "" });
    expect(completions.stdout).toContain("mitome");

    expect(await output(spawn("", ["init", "--help"], current))).toMatchObject({
      exitCode: 0,
      stderr: "",
    });
    expect(await exists(join(current.env.XDG_CONFIG_HOME, "mitome", "agent.ts"))).toBe(false);

    const escaped = await fixture(promptEchoDefinitionSource());
    expect(
      await output(spawn("", ["--use", escaped.definition, "--", "--use"], escaped)),
    ).toMatchObject({ exitCode: 0, stdout: "--use\n", stderr: "" });

    for (const args of [
      ["auth", "bogus"],
      ["init", "extra"],
      ["install", "--use"],
    ]) {
      const result = await output(spawn("", args, current));
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("USAGE");
      expect(result.stderr).toContain("ERROR");
    }
  });

  test("exits 130 when a native prompt is interrupted by closed input", async () => {
    const current = await scaffold("mitome-prompt-interrupt-");

    expect(await output(spawn("", ["init"], current))).toMatchObject({ exitCode: 130 });
    expect(await exists(join(current.env.XDG_CONFIG_HOME, "mitome", "agent.ts"))).toBe(false);
  });

  test("installs Agent Definition dependencies without Bun on PATH or executing it", async () => {
    const current = await installFixture();
    const config = join(current.env.XDG_CONFIG_HOME, "mitome");
    await mkdir(config, { recursive: true });
    // If install ever loaded the config .env, bun would honor this setting and
    // skip writing bun.lock, failing the lockfile assertion below.
    await writeFile(join(config, ".env"), "BUN_CONFIG_SKIP_SAVE_LOCKFILE=1");

    expect(
      await output(spawn("", ["install", "--use", current.definition], current)),
    ).toMatchObject({
      exitCode: 0,
    });
    expect(
      await exists(join(dirname(current.definition), "node_modules", "local-dep", "index.js")),
    ).toBe(true);
    expect(await exists(join(dirname(current.definition), "bun.lock"))).toBe(true);
    expect(await exists(join(current.root, "definition-ran"))).toBe(false);
  });

  test("installs Core beside an Agent Definition and then runs it", async () => {
    const current = await installFixture({ core: true });
    expect(
      await output(spawn("", ["install", "--use", current.definition], current)),
    ).toMatchObject({
      exitCode: 0,
    });
    const coreModules = join(current.root, "pkgs", "core", "node_modules");
    await mkdir(coreModules, { recursive: true });
    await symlink(effectDir, join(dirname(current.definition), "node_modules", "effect"), "dir");
    await symlink(effectDir, join(coreModules, "effect"), "dir");
    await writeFile(current.definition, definitionSource("installed"));

    expect(await output(spawn("", ["hello", "--use", current.definition], current))).toMatchObject({
      exitCode: 0,
      stdout: "installed second\n",
      stderr: "",
    });
  });

  test("runs exactly one positional prompt without reading stdin", async () => {
    const current = await fixture();

    expect(
      await output(spawn("ignored\nignored\n", ["hello", "--use", current.definition], current)),
    ).toMatchObject({
      exitCode: 0,
      stdout: "first second\n",
      stderr: "",
    });
  });

  test("preserves failed installer output and status", async () => {
    const current = await installFixture();
    await writeFile(join(dirname(current.definition), "package.json"), '{"name":');

    const result = await output(spawn("", ["install", "--use", current.definition], current));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("package.json");
  });

  test("loads only XDG or explicit TypeScript Agent Definitions without Bun on PATH", async () => {
    const current = await fixture(definitionSource("default"));
    const configDefinition = join(current.env.XDG_CONFIG_HOME, "mitome", "agent.ts");
    await mkdir(dirname(configDefinition), { recursive: true });
    await cp(current.definition, configDefinition);
    await cp(
      join(dirname(current.definition), "node_modules"),
      join(dirname(configDefinition), "node_modules"),
      {
        recursive: true,
      },
    );
    await writeFile(
      join(current.root, "agent.ts"),
      'throw new Error("project Agent Definition was imported");',
    );

    expect(await output(spawn("", ["hello"], current))).toMatchObject({
      exitCode: 0,
      stdout: "default second\n",
      stderr: "",
    });

    const explicit = join(dirname(current.definition), "explicit.ts");
    await writeFile(explicit, definitionSource("explicit"));
    expect(await output(spawn("", ["hello", "--use", explicit], current))).toMatchObject({
      exitCode: 0,
      stdout: "explicit second\n",
      stderr: "",
    });

    const fallback = await fixture(definitionSource("fallback"));
    const fallbackDefinition = join(fallback.env.HOME, ".config", "mitome", "agent.ts");
    await mkdir(dirname(fallbackDefinition), { recursive: true });
    await cp(fallback.definition, fallbackDefinition);
    await cp(
      join(dirname(fallback.definition), "node_modules"),
      join(dirname(fallbackDefinition), "node_modules"),
      {
        recursive: true,
      },
    );
    expect(
      await output(
        spawn("", ["hello"], fallback, { HOME: fallback.env.HOME, PATH: fallback.env.PATH }),
      ),
    ).toMatchObject({
      exitCode: 0,
      stdout: "fallback second\n",
      stderr: "",
    });
  });

  test("loads exported and quoted config .env values without cwd leakage, and preserves process values", async () => {
    const current = await fixture(envDefinitionSource());
    const config = join(current.env.XDG_CONFIG_HOME, "mitome");
    await mkdir(config, { recursive: true });
    await writeFile(
      join(config, ".env"),
      "export OPENAI_API_KEY=\"config-synthetic\"\nQUOTED_VALUE='quoted-synthetic'\n",
    );
    await writeFile(
      join(current.root, ".env"),
      "OPENAI_API_KEY=cwd-synthetic\nPROBE_ONLY_CWD=leaked\n",
    );

    expect(await output(spawn("", ["hello", "--use", current.definition], current))).toMatchObject({
      exitCode: 0,
      stdout: "config-synthetic:quoted-synthetic:absent\n",
      stderr: "",
    });
    expect(
      await output(
        spawn("", ["hello", "--use", current.definition], current, {
          ...current.env,
          OPENAI_API_KEY: "process-synthetic",
        }),
      ),
    ).toMatchObject({
      exitCode: 0,
      stdout: "process-synthetic:quoted-synthetic:absent\n",
      stderr: "",
    });

    // No config home at all: the empty --env-file fallback must still suppress
    // Bun's automatic cwd .env autoload in the host.
    expect(
      await output(
        spawn("", ["hello", "--use", current.definition], current, {
          HOME: "",
          PATH: current.env.PATH,
        }),
      ),
    ).toMatchObject({
      exitCode: 0,
      stdout: "missing:missing:absent\n",
      stderr: "",
    });
  });

  test("imports an Agent Definition using real installed Effect without Bun on PATH", async () => {
    const current = await fixture();
    expect(
      await exists(join(dirname(current.definition), "node_modules", "effect", "index.js")),
    ).toBe(false);
    expect(
      JSON.parse(
        await readFile(
          join(dirname(current.definition), "node_modules", "effect", "package.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ version: effectPackage.version, exports: effectPackage.exports });
    expect(await output(spawn("", ["hello", "--use", current.definition], current))).toMatchObject({
      exitCode: 0,
      stdout: "first second\n",
      stderr: "",
    });
  });

  test("rejects invalid paths, discovery, config homes, and Agent Definitions", async () => {
    const current = await fixture();
    await writeFile(
      join(current.root, "agent.ts"),
      'throw new Error("project Agent Definition was imported");',
    );

    const directory = await output(
      spawn("", ["hello", "--use", dirname(current.definition)], current),
    );
    expect(directory.exitCode).toBe(1);
    expect(directory.stderr).toContain("TypeScript entry file");

    const implicit = await output(spawn("", [], current));
    expect(implicit.exitCode).toBe(1);
    expect(implicit.stderr).toContain("Missing required argument: prompt");

    const noHomes = await output(
      spawn("", ["hello"], current, { HOME: "", PATH: current.env.PATH }),
    );
    expect(noHomes.exitCode).toBe(1);
    expect(noHomes.stderr).toContain("APPDATA (on Windows)");

    const invalid = await fixture("export default {};");
    const invalidDefinition = await output(
      spawn("", ["hello", "--use", invalid.definition], invalid),
    );
    expect(invalidDefinition.exitCode).toBe(1);
    expect(invalidDefinition.stderr).toContain("Agent Definition must default-export an Agent");

    const accepted = await fixture(promptEchoDefinitionSource());
    const acceptedDefinition = await output(
      spawn("", ["hello", "--use", accepted.definition], accepted),
    );
    expect(acceptedDefinition).toMatchObject({ exitCode: 0, stdout: "hello\n", stderr: "" });

    for (const value of ['"old"', "undefined"]) {
      const oldInstructions = await fixture(
        promptEchoDefinitionSource().replace(
          "model, plugins",
          `instructions: ${value}, model, plugins`,
        ),
      );
      const invalidInstructions = await output(
        spawn("", ["hello", "--use", oldInstructions.definition], oldInstructions),
      );
      expect(invalidInstructions.exitCode).toBe(1);
      expect(invalidInstructions.stderr).toContain("Agent Definition must default-export an Agent");
    }

    const nonStringPluginInstructions = await fixture(
      promptEchoDefinitionSource().replace(
        "plugins: []",
        'plugins: [{ name: "bad", instructions: 1 }]',
      ),
    );
    const invalidPluginInstructions = await output(
      spawn(
        "",
        ["hello", "--use", nonStringPluginInstructions.definition],
        nonStringPluginInstructions,
      ),
    );
    expect(invalidPluginInstructions.exitCode).toBe(1);
    expect(invalidPluginInstructions.stderr).toContain(
      "Agent Definition must default-export an Agent",
    );

    const javascript = join(current.root, "agent.js");
    await writeFile(javascript, "export default {};");
    const nonTypescript = await output(spawn("", ["hello", "--use", javascript], current));
    expect(nonTypescript.exitCode).toBe(1);
    expect(nonTypescript.stderr).toContain("must be a TypeScript entry file");
  });

  test("reports a failed Turn with its cause", async () => {
    const current = await fixture(`
import { Layer, Stream } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { makeModel } from "@mitome/core";

const model = makeModel(Layer.succeed(LanguageModel.LanguageModel, {
  streamText: () => Stream.fail(new Error("provider boom")),
}));
export default { model, plugins: [] };
`);
    const result = await output(spawn("", ["hello", "--use", current.definition], current));
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("TurnError");
    expect(result.stderr).toContain("provider boom");
  });

  test("renders tool-call and tool-result events", async () => {
    const current = await fixture(`
import { Effect, Layer, Schema, Stream } from "effect";
import { LanguageModel, Response, Tool, Toolkit } from "effect/unstable/ai";
import { definePlugin, makeModel } from "@mitome/core";

let calls = 0;
const model = makeModel(Layer.succeed(LanguageModel.LanguageModel, {
  streamText: (options) => {
    calls += 1;
    if (calls === 2) {
      return Stream.succeed(Response.makePart("text-delta", { id: "second", delta: "done" }));
    }
    const call = Response.makePart("tool-call", {
      id: "call-1",
      name: "echo",
      params: { text: "hello" },
      providerExecuted: false,
    });
    return Stream.concat(
      Stream.succeed(call),
      Stream.unwrap(
        options.toolkit.handle("echo", { text: "hello" }).pipe(
          Effect.map((results) =>
            Stream.map(results, (result) =>
              Response.makePart("tool-result", {
                id: call.id,
                name: call.name,
                providerExecuted: false,
                ...result,
              }),
            ),
          ),
        ),
      ),
    );
  },
}));
const echo = Tool.make("echo", {
  parameters: Schema.Struct({ text: Schema.String }),
  success: Schema.String,
});
export default {
  model,
  plugins: [definePlugin({
    name: "echo",
    toolkit: Toolkit.make(echo),
    handlers: { echo: ({ text }) => Effect.succeed(text) },
  })],
};
`);
    const result = await output(spawn("", ["hello", "--use", current.definition], current));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("[tool echo]");
    expect(result.stdout).toContain("[tool echo completed]");
    expect(result.stdout).toContain("done");
  });

  test("checks adjacent Core before Agent Definition execution", async () => {
    const missing = await fixture(
      'import { writeFileSync } from "node:fs"; writeFileSync("marker", "ran");',
    );
    await rm(join(dirname(missing.definition), "node_modules", "@mitome", "core"), {
      recursive: true,
    });
    const missingCore = await output(spawn("", ["hello", "--use", missing.definition], missing));
    expect(missingCore.exitCode).toBe(1);
    expect(missingCore.stderr).toContain(`Install @mitome/core@${corePackage.version}`);
    expect(await exists(join(missing.root, "marker"))).toBe(false);

    const mismatch = await fixture(
      'import { writeFileSync } from "node:fs"; writeFileSync("marker", "ran");',
    );
    const packagePath = join(
      dirname(mismatch.definition),
      "node_modules",
      "@mitome",
      "core",
      "package.json",
    );
    const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as Record<string, unknown>;
    packageJson.version = "999.0.0";
    await writeFile(packagePath, JSON.stringify(packageJson));
    const incompatibleCore = await output(
      spawn("", ["hello", "--use", mismatch.definition], mismatch),
    );
    expect(incompatibleCore.exitCode).toBe(1);
    expect(incompatibleCore.stderr).toContain("999.0.0");
    expect(await exists(join(mismatch.root, "marker"))).toBe(false);
  });

  test("renders events and survives duplicate SIGINT during scoped Turn cleanup", async () => {
    const current = await fixture();
    const signalProbe = {
      pid: join(current.root, "host-pid"),
      cleanupStarted: join(current.root, "cleanup-started"),
      cleanupDone: join(current.root, "cleanup-done"),
    };
    await writeFile(current.definition, definitionSource("first", { block: true, signalProbe }));
    const child = spawn("", ["hello", "--use", current.definition], current);
    const reader = child.stdout.setEncoding("utf8")[Symbol.asyncIterator]();
    const first = await reader.next();
    if (first.done) throw new Error("Missing first output");
    const firstOutput = first.value;
    expect(firstOutput).toContain("first");
    expect(child.exitCode).toBeNull();

    const hostPid = Number(await readFile(signalProbe.pid, "utf8"));
    child.kill("SIGINT");
    for (let attempt = 0; !(await exists(signalProbe.cleanupStarted)); attempt += 1) {
      if (attempt === 500) throw new Error("Session cleanup did not start");
      await delay(10);
    }
    process.kill(hostPid, "SIGINT");
    const tail = await rest(reader);
    expect(await exited(child)).toBe(130);
    expect(await exists(signalProbe.cleanupDone)).toBe(true);
    expect(firstOutput + tail).not.toContain(" second");
  });

  test("auto-approves pending Tool execution without reading stdin", async () => {
    const current = await fixture();
    const marker = join(current.root, "handler-ran");
    await writeFile(current.definition, approvalDefinitionSource(marker));

    const result = await output(
      spawn("ignored\n", ["hello", "--use", current.definition], current),
    );

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("[approval dangerous auto-approved]");
    expect(result.stdout).not.toContain("Approve?");
    expect(result.stdout).toContain("continued");
    expect(await exists(marker)).toBe(true);
  });

  test("initializes an Agent Definition and stores a masked Credential", async () => {
    const current = await scaffold("mitome-cli-");
    const config = join(current.env.XDG_CONFIG_HOME, "mitome");
    await cachedModelHints(current);
    const localPackages = join(current.root, "local-packages");
    const archives = new Map<string, Buffer>();
    for (const packageName of ["core", "plugins", "providers", "sdk"] as const) {
      const source = resolve(packageDir, "..", packageName);
      // npm tarballs root entries under package/; staging the layout keeps tar
      // invocation portable (GNU --transform is unavailable on BSD/macOS tar).
      const destination = join(localPackages, packageName, "package");
      await cp(join(source, "dist"), join(destination, "dist"), { recursive: true });
      await writeFile(
        join(destination, "package.json"),
        JSON.stringify({
          name: `@mitome/${packageName}`,
          version: corePackage.version,
          exports:
            packageName === "providers"
              ? { "./openai": "./dist/openai/index.js" }
              : { ".": "./dist/index.js" },
          peerDependencies:
            packageName === "core" ? undefined : { "@mitome/core": corePackage.version },
        }),
      );
      const archive = join(localPackages, `${packageName}.tgz`);
      const tar = spawnChild(
        "tar",
        ["-C", join(localPackages, packageName), "-czf", archive, "package"],
        { stdio: "ignore" },
      );
      expect(await exited(tar)).toBe(0);
      archives.set(`@mitome/${packageName}`, await readFile(archive));
    }
    const requests: Array<string> = [];
    const registry = createServer((request, response) => {
      const pathname = new URL(request.url!, "http://localhost").pathname;
      requests.push(pathname);
      if (pathname.endsWith(".tgz")) {
        response.end(archives.get(decodeURIComponent(pathname.slice(1, -4))));
        return;
      }
      const name = decodeURIComponent(pathname.slice(1));
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          name,
          "dist-tags": { latest: corePackage.version },
          versions: {
            [corePackage.version]: {
              name,
              version: corePackage.version,
              peerDependencies:
                name === "@mitome/core" ? undefined : { "@mitome/core": corePackage.version },
              dist: { tarball: `${registryUrl}${encodeURIComponent(name)}.tgz` },
            },
          },
        }),
      );
    });
    await new Promise<void>((done) => registry.listen(0, "127.0.0.1", done));
    const registryUrl = `http://127.0.0.1:${(registry.address() as AddressInfo).port}/`;
    await writeFile(join(config, "bunfig.toml"), `[install]\nregistry = "${registryUrl}"\n`);

    const key = "synthetic-init-credential";
    const child = spawn(undefined, ["init"], current);
    child.stdin.write("\n");
    await delay(500);
    child.stdin.write("\n");
    // Prompt.run consumes keypress events while active; feed the Credential
    // after the installer has completed and the password prompt is listening.
    const installedCore = join(config, "node_modules", "@mitome", "core", "package.json");
    for (let attempt = 0; !(await exists(installedCore)); attempt += 1) {
      if (attempt === 500) throw new Error("Agent Definition dependencies were not installed");
      await delay(10);
    }
    child.stdin.end(`${key}\n`);
    const result = await output(child).finally(
      () => new Promise<void>((done) => registry.close(() => done())),
    );
    expect(result).toMatchObject({ exitCode: 0 });
    // 4 packages × (metadata + tarball), pinned by the isolated fixture HOME.
    expect(requests).toHaveLength(8);
    expect(result.stdout + result.stderr).not.toContain(key);
    const definition = await readFile(join(config, "agent.ts"), "utf8");
    expect(definition).toContain('import { defineAgent } from "@mitome/sdk"');
    expect(definition).toContain('import { env, openai } from "@mitome/providers/openai"');
    expect(definition).toContain('openai("gpt-5.6", env("OPENAI_API_KEY"))');
    expect(definition).toContain(
      'plugins: [instructionFiles({ paths: ["./AGENTS.md"], discover: ["AGENTS.md"] })]',
    );
    expect(definition).not.toContain(key);
    expect(JSON.parse(await readFile(join(config, "package.json"), "utf8")).dependencies).toEqual({
      "@mitome/plugins": corePackage.version,
      "@mitome/providers": corePackage.version,
      "@mitome/sdk": corePackage.version,
    });
    expect(await readFile(join(config, "AGENTS.md"), "utf8")).toBe("You are a helpful Agent.\n");
    expect(await exists(join(config, "instructions.md"))).toBe(false);
    expect(await readFile(join(config, ".env"), "utf8")).toBe(`OPENAI_API_KEY=${key}\n`);
    expect((await stat(join(config, ".env"))).mode & 0o777).toBe(0o600);
    expect(await exists(join(config, ".env.example"))).toBe(false);
    expect(await exists(join(config, "bun.lock"))).toBe(true);

    // Prove the scaffold actually loads: auth logout imports it through the
    // auth-host, so a scaffold that no longer parses or mismatches the SDK/
    // provider API fails here. The fixture registry packages carry no
    // dependencies, so link the runtime ones the dists import.
    const configModules = join(config, "node_modules");
    await mkdir(join(configModules, "@effect"), { recursive: true });
    await symlink(effectDir, join(configModules, "effect"), "dir");
    await symlink(aiOpenaiDir, join(configModules, "@effect", "ai-openai"), "dir");
    expect(await output(spawn("", ["auth", "logout"], current))).toMatchObject({ exitCode: 0 });
    expect(await readFile(join(config, ".env"), "utf8")).toBe("");
  });

  test("refuses to clobber an existing default Agent Definition", async () => {
    const current = await fixture();
    const path = join(current.env.XDG_CONFIG_HOME, "mitome", "agent.ts");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "export default {};\n");
    const result = await output(spawn("fixture-model\n", ["init"], current));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("already exists");
    expect(await readFile(path, "utf8")).toBe("export default {};\n");
  });

  test("refuses to clobber a config package.json without an Agent Definition", async () => {
    const current = await scaffold("mitome-cli-");
    const config = join(current.env.XDG_CONFIG_HOME, "mitome");
    await mkdir(config, { recursive: true });
    await writeFile(join(config, "package.json"), '{"name":"hand-edited"}\n');
    const result = await output(spawn("fixture-model\n", ["init"], current));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("already exists");
    expect(await readFile(join(config, "package.json"), "utf8")).toBe('{"name":"hand-edited"}\n');
    expect(await exists(join(config, "agent.ts"))).toBe(false);
  });

  test("refuses to clobber a global AGENTS.md", async () => {
    const current = await scaffold("mitome-cli-");
    const config = join(current.env.XDG_CONFIG_HOME, "mitome");
    await mkdir(config, { recursive: true });
    await writeFile(join(config, "AGENTS.md"), "hand-written\n");

    const result = await output(spawn("fixture-model\n", ["init"], current));

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("AGENTS.md already exists");
    expect(await readFile(join(config, "AGENTS.md"), "utf8")).toBe("hand-written\n");
    expect(await exists(join(config, "agent.ts"))).toBe(false);
  });

  test("initializes Codex without requesting an API key", async () => {
    const current = await scaffold("mitome-cli-");
    const config = join(current.env.XDG_CONFIG_HOME, "mitome");
    await cachedModelHints(current);
    // Unroutable registry stops before OAuth while preserving the generated Definition for inspection.
    await writeFile(join(config, "bunfig.toml"), '[install]\nregistry = "http://127.0.0.1:1/"\n');
    const key = "synthetic-never-stored";
    const child = spawn(undefined, ["init"], current);
    child.stdin.write("j\n");
    await delay(500);
    child.stdin.end(`\n${key}\n`);
    const result = await output(child);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain(key);
    expect(await readFile(join(config, "agent.ts"), "utf8")).toContain(
      'import { codex } from "@mitome/providers/openai-codex"',
    );
    expect(await exists(join(config, ".env"))).toBe(false);
  });

  test("accepts a custom model identifier", async () => {
    const current = await scaffold("mitome-cli-");
    const config = join(current.env.XDG_CONFIG_HOME, "mitome");
    await cachedModelHints(current);
    await writeFile(join(config, "bunfig.toml"), '[install]\nregistry = "http://127.0.0.1:1/"\n');
    const child = spawn(undefined, ["init"], current);
    child.stdin.write("\n");
    await delay(500);
    child.stdin.write(`${"j".repeat(10)}\n`);
    await delay(500);
    child.stdin.end("private-model\n");
    const result = await output(child);
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(join(config, "agent.ts"), "utf8")).toContain(
      'openai("private-model", env("OPENAI_API_KEY"))',
    );
  });

  test("rejects a blank custom model identifier", async () => {
    const current = await scaffold("mitome-cli-");
    await cachedModelHints(current);
    const child = spawn(undefined, ["init"], current);
    child.stdin.write("\n");
    await delay(500);
    child.stdin.write(`${"j".repeat(10)}\n`);
    await delay(500);
    child.stdin.end("   \n");
    const result = await output(child);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Model identifier is required.");
    expect(await exists(join(current.env.XDG_CONFIG_HOME, "mitome", "agent.ts"))).toBe(false);
  });

  test("auth delegates to the Agent Definition credential descriptor without exposing Credentials", async () => {
    const current = await fixture(precedenceDefinitionSource("FIXTURE_PROVIDER_ENV"));
    const config = join(current.env.XDG_CONFIG_HOME, "mitome");
    await mkdir(config, { recursive: true });
    await writeFile(join(config, ".env"), "# retained\nOTHER=present\nFIXTURE_PROVIDER_ENV=old\n");
    const original = await readFile(current.definition, "utf8");
    const key = "synthetic-login-credential";
    const login = await output(
      spawn(`${key}\n`, ["auth", "login", "--use", current.definition], current),
    );
    expect(login).toMatchObject({ exitCode: 0 });
    expect(login.stdout + login.stderr).not.toContain(key);
    expect(await readFile(join(config, ".env"), "utf8")).toBe(
      `# retained\nOTHER=present\nFIXTURE_PROVIDER_ENV=${key}\n`,
    );
    expect(await readFile(current.definition, "utf8")).toBe(original);

    expect(
      await output(
        spawn("", ["auth", "logout", "--use", current.definition], current, {
          ...current.env,
          FIXTURE_PROVIDER_ENV: "process-synthetic",
        }),
      ),
    ).toMatchObject({ exitCode: 0 });
    expect(await readFile(join(config, ".env"), "utf8")).toBe("# retained\nOTHER=present\n");
    expect(await readFile(current.definition, "utf8")).toBe(original);
  });

  test("rejects unknown auth subcommands with usage", async () => {
    const current = await fixture();
    const result = await output(spawn("", ["auth", "bogus"], current));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Unknown subcommand "bogus"');
  });

  test("auth delegates generic OAuth capabilities without a provider registry", async () => {
    const current = await fixture();
    const capability = join(current.root, "capability.mjs");
    const marker = join(current.root, "capability-calls");
    await writeFile(
      capability,
      `import { appendFile } from "node:fs/promises"; export const authenticate = async ({ operation, input, openBrowser }) => appendFile(${JSON.stringify(marker)}, operation + ":" + (operation === "login" ? await input() : "logout") + ":browser=" + String(openBrowser) + "\\n");`,
    );
    await writeFile(
      current.definition,
      `import { Layer, Stream } from "effect";
import { LanguageModel, Response } from "effect/unstable/ai";
import { makeModel } from "@mitome/core";
const model = makeModel(Layer.succeed(LanguageModel.LanguageModel, { streamText: () => Stream.succeed(Response.makePart("text-delta", { id: "fixture", delta: "unused" })) }), { capability: { module: ${JSON.stringify(new URL(`file://${capability}`).href)} } });
export default { model, plugins: [] };`,
    );
    expect(
      await output(
        spawn(
          "http://localhost:1455/auth/callback?code=ac_9rn3xKq&state=deadbeef\n",
          ["auth", "login", "--use", current.definition],
          current,
          {
            ...current.env,
            MITOME_NO_BROWSER: "1",
          },
        ),
      ),
    ).toMatchObject({ exitCode: 0 });
    expect(
      await output(
        spawn("", ["auth", "logout", "--use", current.definition], current, {
          ...current.env,
          MITOME_NO_BROWSER: "1",
        }),
      ),
    ).toMatchObject({ exitCode: 0 });
    // browser=false proves MITOME_NO_BROWSER crossed the process boundary.
    expect(await readFile(marker, "utf8")).toBe(
      "login:http://localhost:1455/auth/callback?code=ac_9rn3xKq&state=deadbeef:browser=false\nlogout:logout:browser=false\n",
    );
  });

  test("auth logout without a stored Credential is a no-op", async () => {
    const current = await fixture(precedenceDefinitionSource("LOGOUT_NOOP_KEY"));
    expect(
      await output(spawn("", ["auth", "logout", "--use", current.definition], current)),
    ).toMatchObject({ exitCode: 0 });
    expect(await exists(join(current.env.XDG_CONFIG_HOME, "mitome", ".env"))).toBe(false);
  });

  test("auth login requires a non-empty Credential", async () => {
    const current = await fixture(precedenceDefinitionSource("EMPTY_LOGIN_KEY"));
    const result = await output(
      spawn("\n", ["auth", "login", "--use", current.definition], current),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Credential value is required.");
    expect(await exists(join(current.env.XDG_CONFIG_HOME, "mitome", ".env"))).toBe(false);
  });

  test("auth login without an Agent Definition directs users to init", async () => {
    const current = await fixture();
    const result = await output(spawn("", ["auth", "login"], current));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("run mitome init first");
    expect(result.stderr).not.toContain("Agent Definition not found");
  });

  test("auth login rejects Credentials that Bun's env parser would corrupt", async () => {
    const current = await fixture(precedenceDefinitionSource("AUTH_REJECT_KEY"));
    const result = await output(
      spawn("has$dollar\n", ["auth", "login", "--use", current.definition], current),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("set the environment variable directly");
    expect(await exists(join(current.env.XDG_CONFIG_HOME, "mitome", ".env"))).toBe(false);
  });

  test("auth login reports a bare Model without a credential descriptor", async () => {
    const current = await fixture(definitionSource("bare"));
    const result = await output(spawn("", ["auth", "login", "--use", current.definition], current));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe("Agent Definition Model does not support CLI authentication.\n");
  });

  test("uses Core directly without SDK runtime support", async () => {
    const packageJson = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(packageJson.devDependencies["@mitome/core"]).toBe("workspace:*");
    expect(packageJson.dependencies?.["@mitome/sdk"]).toBeUndefined();
    expect(packageJson.devDependencies["@mitome/sdk"]).toBeUndefined();
  });
});
