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
import { makeProvider } from "@mitome/core";

${options.signalProbe ? `writeFileSync(${JSON.stringify(options.signalProbe.pid)}, String(process.pid));` : ""}
const provider = makeProvider("test", [], undefined, () => Layer.succeed(LanguageModel.LanguageModel, {
  streamText: () => Stream.concat(
    Stream.succeed(Response.makePart("text-delta", { id: "first", delta: ${JSON.stringify(output)} })),
    ${options.block ? 'Stream.fromEffect(Effect.sleep(10_000).pipe(Effect.as(Response.makePart("text-delta", { id: "second", delta: " second" }))))' : 'Stream.fromEffect(Effect.sleep(100).pipe(Effect.as(Response.makePart("text-delta", { id: "second", delta: " second" }))))'},
  ),
}));
export default { providers: [provider], model: "test/default", plugins: ${
  options.signalProbe
    ? `[{ name: "cleanup", hooks: { sessionEnd: Effect.sync(() => {
      writeFileSync(${JSON.stringify(options.signalProbe.cleanupStarted)}, "");
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
import { makeProvider } from "@mitome/core";

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
export default { providers: [provider], model: "test/default", plugins: [] };
`;

const reexecDefinitionSource = (): string => `
import { Layer, Stream } from "effect";
import { LanguageModel, Response } from "effect/unstable/ai";
import { makeProvider } from "@mitome/core";

const provider = makeProvider("test", [], undefined, () => Layer.succeed(LanguageModel.LanguageModel, {
  streamText: () => Stream.succeed(Response.makePart("text-delta", {
    id: "reexec", delta: process.env.BUN_BE_BUN ?? "missing",
  })),
}));
export default { providers: [provider], model: "test/default", plugins: [] };
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

const installFixture = async (): Promise<Fixture> => {
  const current = await scaffold("mitome-install-");
  const definitionDirectory = dirname(current.definition);
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

  test("maps a non-zero Child Host exit code at the process boundary", async () => {
    const current = await installFixture();
    await writeFile(join(dirname(current.definition), "package.json"), '{"name":');

    const result = await output(spawn("", ["install", "--use", current.definition], current));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("package.json");
  });

  test("prints aggregated Agent Definition errors", async () => {
    const current = await fixture("export default {};\n");
    const result = await output(spawn("", ["hello", "--use", current.definition], current));

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Agent Definition Providers must be an array");
    expect(result.stderr).toContain("Agent Definition Model must be a string");
    expect(result.stderr).toContain("Agent Definition Plugins must be an array");
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
