import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

const installedPackage = (name: string): string => {
  const store = resolve(packageDir, "../../node_modules/.bun");
  const entry = [
    ...new Bun.Glob(`**/node_modules/${name}/package.json`).scanSync({ cwd: store }),
  ][0];
  if (entry === undefined) throw new Error(`Cannot find installed ${name}`);
  return dirname(join(store, entry));
};

const copyPackage = async (
  name: string,
  nodeModules: string,
  copied = new Set<string>(),
): Promise<void> => {
  if (copied.has(name)) return;
  copied.add(name);
  const source = installedPackage(name);
  const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    await copyPackage(dependency, nodeModules, copied);
  }
  const destination = join(nodeModules, name);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, dereference: true });
};

const definitionSource = (output: string, options: { readonly block?: boolean } = {}): string => `
import { Effect, Layer, Stream } from "effect";
import { LanguageModel, Response } from "effect/unstable/ai";
import { makeModel } from "@mitome/core";

interface FixtureOutput { readonly text: string }
const fixture: FixtureOutput = { text: ${JSON.stringify(output)} };
const model = makeModel(Layer.succeed(LanguageModel.LanguageModel, {
  streamText: () => Stream.concat(
    Stream.succeed(Response.makePart("text-delta", { id: "first", delta: fixture.text })),
    ${options.block ? 'Stream.fromEffect(Effect.sleep(10_000).pipe(Effect.as(Response.makePart("text-delta", { id: "second", delta: " second" }))))' : 'Stream.fromEffect(Effect.sleep(100).pipe(Effect.as(Response.makePart("text-delta", { id: "second", delta: " second" }))))'},
  ),
}));
export default { instructions: "Reply with the fixture output.", model, plugins: [] };
`;

type Fixture = {
  readonly root: string;
  readonly definition: string;
  readonly env: Record<string, string>;
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
  await copyPackage("effect", nodeModules);
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
  process.stdin.write(input);
  process.stdin.end();
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
  await Bun.file(binary)
    .exists()
    .then((exists) => {
      if (!exists) throw new Error("Build @mitome/cli before running its subprocess tests");
    });
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

  test("rejects a directory, project discovery, and missing config homes", async () => {
    const current = await fixture();
    await writeFile(
      join(current.root, "agent.ts"),
      'throw new Error("project Definition was imported");',
    );

    const directory = await output(spawn("", ["--use", dirname(current.definition)], current));
    expect(directory.exitCode).not.toBe(0);
    expect(directory.stderr).toContain("TypeScript entry file");

    const implicit = await output(spawn("", [], current));
    expect(implicit.exitCode).not.toBe(0);
    expect(implicit.stderr).toContain("--use <file>");

    const noHomes = await output(spawn("", [], current, { HOME: "", PATH: current.env.PATH }));
    expect(noHomes.exitCode).not.toBe(0);
    expect(noHomes.stderr).toContain("XDG_CONFIG_HOME or HOME");
  });

  test("checks adjacent Core before Definition execution", async () => {
    const missing = await fixture(
      'import { writeFileSync } from "node:fs"; writeFileSync("marker", "ran");',
    );
    await rm(join(dirname(missing.definition), "node_modules", "@mitome", "core"), {
      recursive: true,
    });
    const missingCore = await output(spawn("", ["--use", missing.definition], missing));
    expect(missingCore.exitCode).not.toBe(0);
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
    expect(incompatibleCore.exitCode).not.toBe(0);
    expect(incompatibleCore.stderr).toContain("999.0.0");
    expect(await Bun.file(join(mismatch.root, "marker")).exists()).toBe(false);
  });

  test("renders Core events incrementally and interrupts an active scoped Turn", async () => {
    const current = await fixture(definitionSource("first", { block: true }));
    const process = spawn("hello\n", ["--use", current.definition], current);
    const reader = process.stdout.getReader();
    const first = await reader.read();
    const firstOutput = new TextDecoder().decode(first.value);
    expect(firstOutput).toContain("first");
    expect(process.exitCode).toBeNull();

    process.kill("SIGINT");
    const rest = await new Response(
      new ReadableStream({
        start(controller) {
          const read = async (): Promise<void> => {
            const next = await reader.read();
            if (next.done) return controller.close();
            controller.enqueue(next.value);
            await read();
          };
          void read();
        },
      }),
    ).text();
    expect(await process.exited).toBe(130);
    expect(firstOutput + rest).not.toContain(" second");
  });

  test("uses Core directly without SDK runtime support", async () => {
    const packageJson = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const source = await readFile(join(packageDir, "src", "index.ts"), "utf8");
    expect(packageJson.devDependencies["@mitome/core"]).toBe("workspace:*");
    expect(packageJson.dependencies?.["@mitome/sdk"]).toBeUndefined();
    expect(packageJson.devDependencies["@mitome/sdk"]).toBeUndefined();
    expect(source).toContain("createSession");
    expect(source).not.toContain("@mitome/sdk");
  });
});
