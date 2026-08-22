import { spawn as spawnChild } from "node:child_process";
import { once } from "node:events";
import { existsSync as exists } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { text } from "node:stream/consumers";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, test } from "vitest";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binary = join(packageDir, "dist/local/mitome");
const coreDir = resolve(packageDir, "../core");
const effectDir = dirname(createRequire(import.meta.url).resolve("effect/package.json"));
const cliPackage = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as {
  version: string;
  dependencies?: Record<string, string>;
  devDependencies: Record<string, string>;
};
const temporaryDirectories: Array<string> = [];

const definitionSource = (
  output: string,
  options: {
    readonly block?: boolean;
    readonly tui?: boolean;
    readonly customHost?: boolean;
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
import { defineMitome, makeProvider } from "@mitome/core";
${options.tui ? 'import { tui } from "@mitome/tui";' : ""}

${options.signalProbe ? `writeFileSync(${JSON.stringify(options.signalProbe.pid)}, String(process.pid));` : ""}
const provider = makeProvider("test", [], undefined, () => Layer.succeed(LanguageModel.LanguageModel, {
  streamText: () => Stream.concat(
    Stream.succeed(Response.makePart("text-delta", { id: "first", delta: ${JSON.stringify(output)} })),
    ${options.block ? 'Stream.fromEffect(Effect.sleep(10_000).pipe(Effect.as(Response.makePart("text-delta", { id: "second", delta: " second" }))))' : 'Stream.fromEffect(Effect.sleep(100).pipe(Effect.as(Response.makePart("text-delta", { id: "second", delta: " second" }))))'},
  ),
}));
const agent = { providers: [provider], model: "test/default", extensions: ${
  options.signalProbe
    ? `[{ name: "cleanup", hooks: { sessionEnd: Effect.sync(() => {
      writeFileSync(${JSON.stringify(options.signalProbe.cleanupStarted)}, "");
      const cleanupUntil = Date.now() + 100;
      while (Date.now() < cleanupUntil) {}
      writeFileSync(${JSON.stringify(options.signalProbe.cleanupDone)}, "");
    }) } }]`
    : "[]"
} };
export default defineMitome({ agent, hosts: ${options.tui ? "[tui()]" : options.customHost ? '[{ name: "custom", mode: "interactive", run: async ({ prompt }) => console.log(`CUSTOM_HOST ${prompt}`) }]' : "[]"} });
`;

const envDefinitionSource = (): string => `
import { Layer, Stream } from "effect";
import { LanguageModel, Response } from "effect/unstable/ai";
import { defineMitome, makeProvider } from "@mitome/core";

const provider = makeProvider("test", [], undefined, () => Layer.succeed(LanguageModel.LanguageModel, {
  streamText: () => Stream.succeed(Response.makePart("text-delta", {
    id: "env",
    delta: [
      process.env.OPENAI_API_KEY ?? "missing",
      process.env.QUOTED_VALUE ?? "missing",
      process.env.PROBE_ONLY_CWD ?? "absent",
    ].join(":"),
  })),
}));
export default defineMitome({ agent: { providers: [provider], model: "test/default", extensions: [] }, hosts: [] });
`;

const reexecDefinitionSource = (): string => `
import { Layer, Stream } from "effect";
import { LanguageModel, Response } from "effect/unstable/ai";
import { defineMitome, makeProvider } from "@mitome/core";

const provider = makeProvider("test", [], undefined, () => Layer.succeed(LanguageModel.LanguageModel, {
  streamText: () => Stream.succeed(Response.makePart("text-delta", {
    id: "reexec", delta: process.env.BUN_BE_BUN ?? "missing",
  })),
}));
export default defineMitome({ agent: { providers: [provider], model: "test/default", extensions: [] }, hosts: [] });
`;

const extensionListDefinitionSource = (invalid = false): string => `
import { Layer } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { defineMitome, makeProvider } from "@mitome/core";

const provider = makeProvider("test", [], undefined, () => Layer.succeed(LanguageModel.LanguageModel, {}));
const shared = { name: "fixture-shared" };
const first = { name: "fixture-first", dependencies: [shared] };
const second = { name: "fixture-second", dependencies: [shared] };
const root = { name: "fixture-root", dependencies: [second] };
${invalid ? 'const cycle = { name: "fixture-cycle", instructions: 42 }; cycle.dependencies = [cycle];' : ""}
export default defineMitome({
  agent: {
    providers: [provider],
    model: "test/default",
    extensions: ${invalid ? "[first, cycle]" : "[first, second, root]"},
  },
  hosts: [],
});
`;

const persistentExtensionListDefinitionSource = (): string => `
import { Layer } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { defineMitome, makeProvider } from "@mitome/core";

setInterval(() => {}, 60_000);
const provider = makeProvider("test", [], undefined, () => Layer.succeed(LanguageModel.LanguageModel, {}));
export default defineMitome({
  agent: {
    providers: [provider],
    model: "test/default",
    extensions: [{ name: process.env.MITOME_EXTENSION_NAME ?? "missing-env" }],
  },
  hosts: [],
});
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

const writePackageVersion = async (
  current: Fixture,
  name: string,
  version: string,
): Promise<void> => {
  const directory = join(dirname(current.definition), "node_modules", name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ name, version }));
};

const installTui = async (current: Fixture): Promise<void> => {
  const nodeModules = join(dirname(current.definition), "node_modules");
  const tui = join(nodeModules, "@mitome", "tui");
  await mkdir(tui, { recursive: true });
  await writeFile(
    join(tui, "package.json"),
    JSON.stringify({ name: "@mitome/tui", type: "module", exports: "./index.js" }),
  );
  await writeFile(
    join(tui, "index.js"),
    'export const tui = () => ({ name: "tui", mode: "interactive", unsupported: () => process.env.TERM_PROGRAM === "ghostty" ? undefined : "@mitome/tui currently supports Ghostty on Linux", run: ({ prompt }) => process.stdout.write(`TUI_PROMPT ${JSON.stringify(prompt)}\\n`) });\n',
  );
};

const installFixture = async (): Promise<Fixture> => {
  const current = await scaffold("mitome-install-");
  const definitionDirectory = dirname(current.definition);
  const packages = join(current.root, "pkgs");
  const marker = join(current.root, "definition-ran");
  await mkdir(join(packages, "local-dep"), { recursive: true });
  await writeFile(
    join(packages, "local-dep", "package.json"),
    JSON.stringify({
      name: "local-dep",
      version: "1.0.0",
      type: "module",
      exports: "./index.js",
    }),
  );
  await writeFile(
    join(packages, "local-dep", "index.js"),
    "export function helper() {}\nexport function localDep() { return { name: 'local' }; }\n",
  );
  await mkdir(definitionDirectory, { recursive: true });
  await writeFile(
    current.definition,
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");`,
  );
  await writeFile(
    join(definitionDirectory, "package.json"),
    JSON.stringify({
      name: "definition",
      private: true,
      dependencies: { "local-dep": "file:../pkgs/local-dep" },
    }),
  );
  return current;
};

const reconcileFixture = async (): Promise<Fixture> => {
  const current = await scaffold("mitome-reconcile-");
  const definitionDirectory = dirname(current.definition);
  const localCore = join(definitionDirectory, "packages", "core");
  await mkdir(localCore, { recursive: true });
  await cp(join(coreDir, "dist"), join(localCore, "dist"), { recursive: true });
  await writeFile(
    join(localCore, "package.json"),
    JSON.stringify({
      name: "@mitome/core",
      version: "0.0.0",
      type: "module",
      exports: { ".": "./dist/index.js", "./package.json": "./package.json" },
      peerDependencies: { effect: cliPackage.devDependencies.effect },
    }),
  );
  await mkdir(definitionDirectory, { recursive: true });
  await writeFile(current.definition, definitionSource("reconciled"));
  await writeFile(
    join(definitionDirectory, "package.json"),
    JSON.stringify({
      name: "definition",
      private: true,
      dependencies: {
        "@mitome/core": "file:./packages/core",
        effect: `file:${effectDir}`,
      },
    }),
  );
  return current;
};

const spawn = (
  input: string,
  args: ReadonlyArray<string>,
  current: Fixture,
  env: Record<string, string> = current.env,
) => {
  const child = spawnChild(binary, args, {
    cwd: current.root,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(input);
  return child;
};

const exited = async (child: ReturnType<typeof spawnChild>): Promise<number | null> => {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  const [code] = await once(child, "close");
  return code;
};

const output = async (child: ReturnType<typeof spawn>) => {
  const [stdout, stderr, exitCode] = await Promise.all([
    text(child.stdout),
    text(child.stderr),
    exited(child),
  ]);
  return { stdout, stderr, exitCode };
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

const ptyOutput = (
  args: ReadonlyArray<string>,
  current: Fixture,
  terminal = "ghostty",
): Promise<Awaited<ReturnType<typeof output>>> => {
  const command = [binary, ...args].map(shellQuote).join(" ");
  const child = spawnChild("/usr/bin/script", ["-qec", command, "/dev/null"], {
    cwd: current.root,
    env: { ...current.env, TERM_PROGRAM: terminal },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end();
  return output(child);
};

const ptyUnavailable = process.platform !== "linux" || !exists("/usr/bin/script");

type StdoutReader = AsyncIterator<string>;

const rest = async (reader: StdoutReader) => {
  let output = "";
  for (let next = await reader.next(); !next.done; next = await reader.next()) {
    output += next.value;
  }
  return output;
};

beforeAll(() => {
  if (!exists(binary)) {
    throw new Error("Build @mitome/cli before running its subprocess tests");
  }
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("compiled mitome", () => {
  test("boots and prints its version", async () => {
    const current = await scaffold("mitome-version-");

    expect(await output(spawn("", ["--version"], current))).toMatchObject({
      exitCode: 0,
      stdout: `mitome v${cliPackage.version}\n`,
      stderr: "",
    });
  });

  test("exits 130 when the production Prompter receives closed input", async () => {
    const current = await scaffold("mitome-prompt-interrupt-");

    expect(await output(spawn("", ["init"], current))).toMatchObject({ exitCode: 130 });
    expect(exists(join(current.env.XDG_CONFIG_HOME, "mitome", "index.ts"))).toBe(false);
  });

  test("re-executes the Child Host through BUN_BE_BUN", async () => {
    const current = await fixture(reexecDefinitionSource());

    expect(await output(spawn("", ["hello", "--use", current.definition], current))).toMatchObject({
      exitCode: 0,
      stdout: "1\n",
      stderr: "",
    });
  });

  test("keeps bare invocation unavailable without an interactive Host", async ({ skip }) => {
    if (ptyUnavailable) skip();
    const current = await fixture();

    const result = await output(spawn("", ["--use", current.definition], current));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Missing argument prompt");

    // A TTY without a declared interactive Host exercises the child's missing-prompt branch.
    const tty = await ptyOutput(["--use", current.definition], current);
    expect(tty.exitCode).not.toBe(0);
    expect(tty.stdout + tty.stderr).toContain("Missing argument prompt");
  });

  test("does not activate an installed but unconfigured TUI package", async ({ skip }) => {
    if (ptyUnavailable) skip();
    const current = await fixture();
    await installTui(current);

    const result = await ptyOutput(["hello", "--use", current.definition], current);
    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.stdout).toContain("first second");
    expect(result.stdout).not.toContain("TUI_PROMPT");
  });

  test("rejects a selected module that does not export defineMitome", async () => {
    const current = await fixture("export default {};\n");

    const result = await output(spawn("", ["hello", "--use", current.definition], current));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("must default-export defineMitome({ agent, hosts })");
  });

  test("opens a configured TUI in a supported terminal with optional prompt staging", async ({
    skip,
  }) => {
    if (ptyUnavailable) skip();
    const current = await fixture();
    await installTui(current);
    await writeFile(current.definition, definitionSource("first", { tui: true }));

    const prompted = await ptyOutput(["hello", "--use", current.definition], current);
    expect(prompted).toMatchObject({ exitCode: 0 });
    expect(prompted.stdout).toContain('TUI_PROMPT "hello"');
    expect(prompted.stdout).not.toContain("first second");

    const bare = await ptyOutput(["--use", current.definition], current);
    expect(bare).toMatchObject({ exitCode: 0 });
    expect(bare.stdout).toContain('TUI_PROMPT ""');
  });

  test("runs a custom interactive Host outside the TUI terminal matrix", async ({ skip }) => {
    if (ptyUnavailable) skip();
    const current = await fixture(definitionSource("first", { customHost: true }));

    const result = await ptyOutput(["hello", "--use", current.definition], current, "xterm");
    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.stdout).toContain("CUSTOM_HOST hello");
    expect(result.stdout).not.toContain("falling back to one-shot output");
  });

  test("forces one-shot output for --print and non-TTY stdout when the TUI is configured", async ({
    skip,
  }) => {
    if (ptyUnavailable) skip();
    const current = await fixture();
    await installTui(current);
    await writeFile(current.definition, definitionSource("first", { tui: true }));

    for (const flag of ["-p", "--print"]) {
      const printed = await ptyOutput([flag, "hello", "--use", current.definition], current);
      expect(printed).toMatchObject({ exitCode: 0 });
      expect(printed.stdout).toContain("first second");
      expect(printed.stdout).not.toContain("TUI_PROMPT");

      const missing = await ptyOutput([flag, "--use", current.definition], current);
      expect(missing.exitCode).not.toBe(0);
      expect(missing.stdout + missing.stderr).toContain("Missing argument prompt");
    }

    expect(await output(spawn("", ["hello", "--use", current.definition], current))).toMatchObject({
      exitCode: 0,
      stdout: "first second\n",
      stderr: "",
    });
    const missing = await output(spawn("", ["--use", current.definition], current));
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain("Missing argument prompt");
  });

  test("reports an unsupported terminal and falls back to one-shot output", async ({ skip }) => {
    if (ptyUnavailable) skip();
    const current = await fixture();
    await installTui(current);
    await writeFile(current.definition, definitionSource("first", { tui: true }));

    const result = await ptyOutput(["hello", "--use", current.definition], current, "xterm");
    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.stdout).toContain("currently supports Ghostty on Linux");
    expect(result.stdout).toContain("falling back to one-shot output");
    expect(result.stdout).toContain("first second");
    expect(result.stdout).not.toContain("TUI_PROMPT");

    const missing = await ptyOutput(["--use", current.definition], current, "xterm");
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stdout + missing.stderr).toContain("Missing argument prompt");
    expect(missing.stdout).not.toContain("TUI_PROMPT");
  });

  test("loads the config env file in the Child Host without cwd leakage", async () => {
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
  });

  test("forwards SIGINT to the Child Host through scoped Turn cleanup", async () => {
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
    expect(first.value).toContain("first");

    const hostPid = Number(await readFile(signalProbe.pid, "utf8"));
    child.kill("SIGINT");
    for (let attempt = 0; !exists(signalProbe.cleanupStarted); attempt += 1) {
      if (attempt === 500) throw new Error("Session cleanup did not start");
      await delay(10);
    }
    process.kill(hostPid, "SIGINT");
    const tail = await rest(reader);
    expect(await exited(child)).toBe(130);
    expect(exists(signalProbe.cleanupDone)).toBe(true);
    expect(first.value + tail).not.toContain(" second");
  });

  test("round-trips one Agent Definition dependency installation", async () => {
    const current = await installFixture();
    const config = join(current.env.XDG_CONFIG_HOME, "mitome");
    await mkdir(config, { recursive: true });
    await writeFile(join(config, ".env"), "BUN_CONFIG_SKIP_SAVE_LOCKFILE=1");

    expect(
      await output(spawn("", ["install", "--use", current.definition], current)),
    ).toMatchObject({ exitCode: 0 });
    expect(exists(join(dirname(current.definition), "node_modules", "local-dep", "index.js"))).toBe(
      true,
    );
    expect(exists(join(dirname(current.definition), "bun.lock"))).toBe(true);
    expect(exists(join(current.root, "definition-ran"))).toBe(false);
  });

  test("reconciles a selected fresh Agent Definition before importing it", async () => {
    const current = await reconcileFixture();
    const result = await output(spawn("", ["hello", "--use", current.definition], current));

    expect(result).toMatchObject({
      exitCode: 0,
      stderr: expect.not.stringContaining("Cannot find package"),
    });
    expect(result.stdout).toContain("Installing Mitome Definition dependencies...");
    expect(result.stdout).toContain("reconciled second\n");
    expect(exists(join(dirname(current.definition), "node_modules", "@mitome", "core"))).toBe(true);
    expect(exists(join(dirname(current.definition), "bun.lock"))).toBe(true);
  });

  test("reconciles the configured default Agent Definition", async () => {
    const current = await reconcileFixture();
    const config = join(current.env.XDG_CONFIG_HOME, "mitome");
    await cp(dirname(current.definition), config, { recursive: true });
    await writeFile(join(config, "index.ts"), await readFile(current.definition, "utf8"));

    const result = await output(spawn("", ["hello"], current));
    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.stdout).toContain("Installing Mitome Definition dependencies...");
    expect(result.stdout).toContain("reconciled second\n");
    expect(exists(join(config, "node_modules", "@mitome", "core"))).toBe(true);
  });

  test("keeps a workspace Agent Definition with hoisted dependencies quiet", async () => {
    const current = await fixture();
    const directory = dirname(current.definition);
    await cp(join(directory, "node_modules"), join(current.root, "node_modules"), {
      recursive: true,
    });
    await rm(join(directory, "node_modules"), { recursive: true });
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        name: "definition",
        dependencies: { "@mitome/core": "*", effect: "*" },
      }),
    );
    await writeFile(
      join(current.root, "package.json"),
      JSON.stringify({ name: "workspace", private: true, workspaces: ["definition"] }),
    );

    expect(await output(spawn("", ["hello", "--use", current.definition], current))).toMatchObject({
      exitCode: 0,
      stdout: "first second\n",
      stderr: "",
    });
    expect(exists(join(directory, "node_modules"))).toBe(false);
  });

  test("keeps an up-to-date installation quiet and names undeclared missing Extensions", async () => {
    const current = await reconcileFixture();
    expect(await output(spawn("", ["hello", "--use", current.definition], current))).toMatchObject({
      exitCode: 0,
    });

    await rm(join(dirname(current.definition), "bun.lock"));
    const quiet = await output(spawn("", ["hello", "--use", current.definition], current));
    expect(quiet).toMatchObject({
      exitCode: 0,
      stdout: "reconciled second\n",
      stderr: "",
    });

    const definitionDirectory = dirname(current.definition);
    const declaredExtension = join(definitionDirectory, "packages", "declared-extension");
    await mkdir(declaredExtension, { recursive: true });
    await writeFile(
      join(declaredExtension, "package.json"),
      JSON.stringify({ name: "declared-fixture-extension", version: "1.0.0" }),
    );
    const manifest = JSON.parse(
      await readFile(join(definitionDirectory, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    manifest.dependencies["declared-fixture-extension"] = "file:./packages/declared-extension";
    await writeFile(join(definitionDirectory, "package.json"), JSON.stringify(manifest));
    const stale = await output(spawn("", ["hello", "--use", current.definition], current));
    expect(stale).toMatchObject({ exitCode: 0 });
    expect(stale.stdout).toContain("Installing Mitome Definition dependencies...");
    expect(exists(join(definitionDirectory, "node_modules", "declared-fixture-extension"))).toBe(
      true,
    );

    await writeFile(
      current.definition,
      'import extension from "missing-fixture-extension";\nexport default extension;\n',
    );
    const missing = await output(spawn("", ["hello", "--use", current.definition], current));
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stdout).not.toContain("Installing Mitome Definition dependencies");
    expect(missing.stderr).toContain("missing-fixture-extension");
  });

  test("never reconciles a directory that was not selected", async () => {
    const current = await reconcileFixture();
    const unselected = join(current.root, "unselected");
    await mkdir(unselected);
    await writeFile(join(unselected, "index.ts"), "export default {};\n");
    await writeFile(
      join(unselected, "package.json"),
      JSON.stringify({ dependencies: { "left-pad": "1.3.0" } }),
    );

    expect(await output(spawn("", ["hello", "--use", current.definition], current))).toMatchObject({
      exitCode: 0,
    });
    expect(exists(join(unselected, "node_modules"))).toBe(false);
    expect(exists(join(unselected, "bun.lock"))).toBe(false);
  });

  test("adds an Extension only to the selected Agent Definition", async () => {
    const current = await installFixture();
    const definitionDirectory = dirname(current.definition);
    const packagePath = join(definitionDirectory, "package.json");
    const manifest = JSON.parse(await readFile(packagePath, "utf8")) as {
      dependencies: Record<string, string>;
    };
    delete manifest.dependencies["local-dep"];
    await writeFile(packagePath, JSON.stringify(manifest));
    const unselectedPackagePath = join(current.root, "unselected", "package.json");
    await mkdir(dirname(unselectedPackagePath), { recursive: true });
    await writeFile(unselectedPackagePath, '{"name":"unselected","private":true}\n');

    const result = await output(
      spawn("", ["add", "--use", current.definition, "local-dep@file:../pkgs/local-dep"], current),
    );

    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.stdout).toContain(
      'import { localDep } from "local-dep";\nextensions: [localDep()],',
    );
    expect(JSON.parse(await readFile(packagePath, "utf8"))).toMatchObject({
      dependencies: { "local-dep": "file:../pkgs/local-dep" },
    });
    expect(exists(join(definitionDirectory, "node_modules", "local-dep", "index.js"))).toBe(true);
    expect(await readFile(unselectedPackagePath, "utf8")).toBe(
      '{"name":"unselected","private":true}\n',
    );
  });

  test("rejects path-like package names before touching the manifest", async () => {
    const current = await installFixture();
    const packagePath = join(dirname(current.definition), "package.json");
    const original = await readFile(packagePath, "utf8");

    const result = await output(
      spawn("", ["add", "--use", current.definition, "..@1.0.0"], current),
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Invalid package specifier");
    expect(await readFile(packagePath, "utf8")).toBe(original);
  });

  test("restores the manifest and install state when the requested install fails", async () => {
    const current = await installFixture();
    const definitionDirectory = dirname(current.definition);
    const packagePath = join(definitionDirectory, "package.json");
    // A failing lifecycle script makes bun save the lockfile and node_modules before exiting
    // nonzero, which is the state the rollback must undo.
    const manifest = JSON.parse(await readFile(packagePath, "utf8")) as Record<string, unknown>;
    delete (manifest.dependencies as Record<string, string>)["local-dep"];
    manifest.scripts = { postinstall: "exit 1" };
    await writeFile(packagePath, JSON.stringify(manifest));

    const result = await output(
      spawn("", ["add", "--use", current.definition, "local-dep@file:../pkgs/local-dep"], current),
    );

    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(await readFile(packagePath, "utf8"))).toEqual(manifest);
    expect(exists(join(definitionDirectory, "node_modules", "local-dep"))).toBe(false);
    const lockPath = join(definitionDirectory, "bun.lock");
    if (exists(lockPath)) {
      expect(await readFile(lockPath, "utf8")).not.toContain("local-dep");
    }
  });

  test("removes and prunes an Extension only from the selected Agent Definition", async () => {
    const current = await installFixture();
    const definitionDirectory = dirname(current.definition);
    const packagePath = join(definitionDirectory, "package.json");
    const unselectedPackagePath = join(current.root, "unselected", "package.json");
    await mkdir(dirname(unselectedPackagePath), { recursive: true });
    await writeFile(
      unselectedPackagePath,
      '{"name":"unselected","private":true,"dependencies":{"local-dep":"1.0.0"}}\n',
    );
    expect(
      await output(spawn("", ["install", "--use", current.definition], current)),
    ).toMatchObject({ exitCode: 0 });
    expect(exists(join(definitionDirectory, "node_modules", "local-dep", "index.js"))).toBe(true);

    const result = await output(
      spawn("", ["remove", "--use", current.definition, "local-dep"], current),
    );

    expect(result).toMatchObject({ exitCode: 0 });
    const updatedManifest = JSON.parse(await readFile(packagePath, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(updatedManifest.dependencies?.["local-dep"]).toBeUndefined();
    expect(exists(join(definitionDirectory, "node_modules", "local-dep"))).toBe(false);
    expect(() => createRequire(current.definition).resolve("local-dep")).toThrow();
    expect(await readFile(unselectedPackagePath, "utf8")).toBe(
      '{"name":"unselected","private":true,"dependencies":{"local-dep":"1.0.0"}}\n',
    );
  });

  test("maps a non-zero Child Host exit code at the process boundary", async () => {
    const current = await installFixture();
    await writeFile(join(dirname(current.definition), "package.json"), '{"name":');

    const result = await output(spawn("", ["install", "--use", current.definition], current));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("package.json");
  });

  test("prints aggregated Agent Definition errors", async () => {
    const current = await fixture("export default { agent: {}, hosts: [] };\n");
    const result = await output(spawn("", ["hello", "--use", current.definition], current));

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Agent Definition Providers must be an array");
    expect(result.stderr).toContain("Agent Definition Model must be a string");
    expect(result.stderr).toContain("Agent Definition Extensions must be an array");
  });

  test("lists Extensions in compiled order with direct and dependency provenance", async () => {
    const current = await fixture(extensionListDefinitionSource());
    await writePackageVersion(current, "fixture-shared", "1.2.3");
    await writePackageVersion(current, "fixture-first", "2.0.0");
    await writePackageVersion(current, "fixture-second", "3.1.0");

    expect(await output(spawn("", ["ext", "list", "--use", current.definition], current))).toEqual({
      exitCode: 0,
      stdout: [
        "fixture-shared\t1.2.3\tdependency of fixture-first, fixture-second",
        "fixture-first\t2.0.0\tdirect",
        "fixture-second\t3.1.0\tdirect",
        "fixture-root\tunknown\tdirect",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  test("reports compile issues instead of a partial Extension list", async () => {
    const current = await fixture(extensionListDefinitionSource(true));

    const result = await output(spawn("", ["ext", "list", "--use", current.definition], current));

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Extension dependency cycle: fixture-cycle -> fixture-cycle");
    expect(result.stderr).toContain("Extension fixture-cycle Instructions must be a string");
  });

  test("loads config env while inspecting and exits despite active handles", async () => {
    const current = await fixture(persistentExtensionListDefinitionSource());
    const config = join(current.env.XDG_CONFIG_HOME, "mitome");
    await mkdir(config, { recursive: true });
    await writeFile(join(config, ".env"), "MITOME_EXTENSION_NAME=config-extension\n");

    expect(await output(spawn("", ["ext", "list", "--use", current.definition], current))).toEqual({
      exitCode: 0,
      stdout: "config-extension\tunknown\tdirect\n",
      stderr: "",
    });
  });

  test("runs one Turn end to end", async () => {
    const current = await fixture();

    expect(
      await output(spawn("ignored\n", ["hello", "--use", current.definition], current)),
    ).toMatchObject({
      exitCode: 0,
      stdout: "first second\n",
      stderr: "",
    });
  });

  test("uses Core directly without SDK runtime support", () => {
    expect(cliPackage.devDependencies["@mitome/core"]).toBe("workspace:*");
    expect(cliPackage.dependencies?.["@mitome/sdk"]).toBeUndefined();
    expect(cliPackage.devDependencies["@mitome/sdk"]).toBeUndefined();
  });
});
