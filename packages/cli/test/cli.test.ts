import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const packageDir = resolve(import.meta.dir, "..");
const binary = join(packageDir, "dist/mitome");
const coreDir = resolve(packageDir, "../core");
const effectDir = resolve(packageDir, "../../node_modules/effect");
const corePackage = JSON.parse(await readFile(join(coreDir, "package.json"), "utf8")) as {
  version: string;
};
const effectPackage = JSON.parse(await readFile(join(effectDir, "package.json"), "utf8")) as {
  version: string;
  exports: Record<string, string>;
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
export default { instructions: "Reply with the fixture output.", model, plugins: ${
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

type Fixture = {
  readonly root: string;
  readonly definition: string;
  readonly env: {
    readonly HOME: string;
    readonly XDG_CONFIG_HOME: string;
    readonly PATH: string;
  };
};

const fixture = async (source = definitionSource("first")): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), "mitome-cli-"));
  temporaryDirectories.push(root);
  const definition = join(root, "definition", "agent.ts");
  const nodeModules = join(dirname(definition), "node_modules");
  const core = join(nodeModules, "@mitome", "core");
  await mkdir(core, { recursive: true });
  await writeFile(definition, source);
  await cp(join(coreDir, "dist"), join(core, "dist"), { recursive: true });
  await cp(join(coreDir, "package.json"), join(core, "package.json"));
  await symlink(effectDir, join(nodeModules, "effect"), "dir");
  const emptyPath = join(root, "empty-path");
  await mkdir(emptyPath);
  return {
    root,
    definition,
    env: {
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: join(root, "xdg"),
      PATH: emptyPath,
    },
  };
};

const spawn = (
  input: string,
  args: ReadonlyArray<string>,
  current: Fixture,
  env: Record<string, string> = current.env,
) => {
  const process = Bun.spawn([binary, ...args], {
    cwd: current.root,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  void process.stdin.write(input);
  void process.stdin.end();
  return process;
};

const output = async (process: ReturnType<typeof spawn>) => {
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout, stderr, exitCode };
};

beforeAll(async () => {
  if (!(await Bun.file(binary).exists())) {
    throw new Error("Build @mitome/cli before running its subprocess tests");
  }
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("compiled mitome", () => {
  test("loads only XDG or explicit TypeScript Definitions without Bun on PATH", async () => {
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
      'throw new Error("project Definition was imported");',
    );

    expect(await output(spawn("hello\n", [], current))).toMatchObject({
      exitCode: 0,
      stdout: "default second\n",
      stderr: "",
    });

    const explicit = join(dirname(current.definition), "explicit.ts");
    await writeFile(explicit, definitionSource("explicit"));
    expect(await output(spawn("hello\n", ["--use", explicit], current))).toMatchObject({
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
        spawn("hello\n", [], fallback, { HOME: fallback.env.HOME, PATH: fallback.env.PATH }),
      ),
    ).toMatchObject({
      exitCode: 0,
      stdout: "fallback second\n",
      stderr: "",
    });
  });

  test("imports a Definition using real installed Effect without Bun on PATH", async () => {
    const current = await fixture();
    expect(
      await Bun.file(
        join(dirname(current.definition), "node_modules", "effect", "index.js"),
      ).exists(),
    ).toBe(false);
    expect(
      JSON.parse(
        await readFile(
          join(dirname(current.definition), "node_modules", "effect", "package.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ version: effectPackage.version, exports: effectPackage.exports });
    expect(await output(spawn("hello\n", ["--use", current.definition], current))).toMatchObject({
      exitCode: 0,
      stdout: "first second\n",
      stderr: "",
    });
  });

  test("rejects invalid paths, discovery, config homes, and Definitions", async () => {
    const current = await fixture();
    await writeFile(
      join(current.root, "agent.ts"),
      'throw new Error("project Definition was imported");',
    );

    const directory = await output(spawn("", ["--use", dirname(current.definition)], current));
    expect(directory.exitCode).toBe(1);
    expect(directory.stderr).toContain("TypeScript entry file");

    const implicit = await output(spawn("", [], current));
    expect(implicit.exitCode).toBe(1);
    expect(implicit.stderr).toContain("--use <file>");

    const noHomes = await output(spawn("", [], current, { HOME: "", PATH: current.env.PATH }));
    expect(noHomes.exitCode).toBe(1);
    expect(noHomes.stderr).toContain("XDG_CONFIG_HOME or HOME");

    const invalid = await fixture("export default {};");
    const invalidDefinition = await output(spawn("", ["--use", invalid.definition], invalid));
    expect(invalidDefinition.exitCode).toBe(1);
    expect(invalidDefinition.stderr).toContain("Definition must default-export an Agent");
  });

  test("checks adjacent Core before Definition execution", async () => {
    const missing = await fixture(
      'import { writeFileSync } from "node:fs"; writeFileSync("marker", "ran");',
    );
    await rm(join(dirname(missing.definition), "node_modules", "@mitome", "core"), {
      recursive: true,
    });
    const missingCore = await output(spawn("", ["--use", missing.definition], missing));
    expect(missingCore.exitCode).toBe(1);
    expect(missingCore.stderr).toContain(`install @mitome/core@${corePackage.version}`);
    expect(await Bun.file(join(missing.root, "marker")).exists()).toBe(false);

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
    const incompatibleCore = await output(spawn("", ["--use", mismatch.definition], mismatch));
    expect(incompatibleCore.exitCode).toBe(1);
    expect(incompatibleCore.stderr).toContain("999.0.0");
    expect(await Bun.file(join(mismatch.root, "marker")).exists()).toBe(false);
  });

  test("renders events and survives duplicate SIGINT during scoped Turn cleanup", async () => {
    const current = await fixture();
    const signalProbe = {
      pid: join(current.root, "host-pid"),
      cleanupStarted: join(current.root, "cleanup-started"),
      cleanupDone: join(current.root, "cleanup-done"),
    };
    await writeFile(current.definition, definitionSource("first", { block: true, signalProbe }));
    const child = spawn("hello\n", ["--use", current.definition], current);
    const reader = child.stdout.getReader();
    const first = await reader.read();
    const decoder = new TextDecoder();
    const firstOutput = decoder.decode(first.value, { stream: true });
    expect(firstOutput).toContain("first");
    expect(child.exitCode).toBeNull();

    const hostPid = Number(await readFile(signalProbe.pid, "utf8"));
    child.kill("SIGINT");
    for (let attempt = 0; !(await Bun.file(signalProbe.cleanupStarted).exists()); attempt += 1) {
      if (attempt === 100) throw new Error("Session cleanup did not start");
      await Bun.sleep(5);
    }
    process.kill(hostPid, "SIGINT");
    let rest = "";
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      rest += decoder.decode(next.value, { stream: true });
    }
    rest += decoder.decode();
    expect(await child.exited).toBe(130);
    expect(await Bun.file(signalProbe.cleanupDone).exists()).toBe(true);
    expect(firstOutput + rest).not.toContain(" second");
  });
});
