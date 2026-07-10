import { spawn as spawnChild, type ChildProcess } from "node:child_process";
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

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binary = join(packageDir, "dist/mitome");
const coreDir = resolve(packageDir, "../core");
const effectDir = dirname(createRequire(import.meta.url).resolve("effect/package.json"));
const aiOpenaiDir = dirname(
  createRequire(join(packageDir, "..", "openai", "package.json")).resolve(
    "@effect/ai-openai/package.json",
  ),
);
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
export default { instructions: "", model, plugins: [] };
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
export default { instructions: "", model, plugins: [] };
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
  instructions: "Approve the fixture Tool.",
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

const exited = (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
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

const spawnInteractive = (args: ReadonlyArray<string>, current: Fixture) =>
  spawnChild(binary, args, {
    cwd: current.root,
    env: current.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

type StdoutReader = AsyncIterator<string>;

const readUntil = async (reader: StdoutReader, marker: string) => {
  let output = "";
  while (!output.includes(marker)) {
    const next = await reader.next();
    if (next.done) throw new Error(`Missing ${marker} in ${output}`);
    output += next.value;
  }
  return output;
};

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
  test("installs Definition dependencies without Bun on PATH or executing the Definition", async () => {
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

  test("installs Core beside a Definition and then runs it", async () => {
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

    expect(await output(spawn("hello\n", ["--use", current.definition], current))).toMatchObject({
      exitCode: 0,
      stdout: "installed second\n",
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

    expect(await output(spawn("hello\n", ["--use", current.definition], current))).toMatchObject({
      exitCode: 0,
      stdout: "config-synthetic:quoted-synthetic:absent\n",
      stderr: "",
    });
    expect(
      await output(
        spawn("hello\n", ["--use", current.definition], current, {
          ...current.env,
          OPENAI_API_KEY: "process-synthetic",
        }),
      ),
    ).toMatchObject({
      exitCode: 0,
      stdout: "process-synthetic:quoted-synthetic:absent\n",
      stderr: "",
    });

    // No config home at all: the /dev/null --env-file fallback must still suppress
    // Bun's automatic cwd .env autoload in the host.
    expect(
      await output(
        spawn("hello\n", ["--use", current.definition], current, {
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

  test("imports a Definition using real installed Effect without Bun on PATH", async () => {
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

    const javascript = join(current.root, "agent.js");
    await writeFile(javascript, "export default {};");
    const nonTypescript = await output(spawn("", ["--use", javascript], current));
    expect(nonTypescript.exitCode).toBe(1);
    expect(nonTypescript.stderr).toContain("must be a TypeScript entry file");
  });

  test("reports a failed Turn with its cause and keeps the Session usable", async () => {
    const current = await fixture(`
import { Layer, Stream } from "effect";
import { LanguageModel, Response } from "effect/unstable/ai";
import { makeModel } from "@mitome/core";

let calls = 0;
const model = makeModel(Layer.succeed(LanguageModel.LanguageModel, {
  streamText: () => {
    calls += 1;
    return calls === 2
      ? Stream.fail(new Error("provider boom"))
      : Stream.succeed(Response.makePart("text-delta", { id: String(calls), delta: "ok" + calls }));
  },
}));
export default { instructions: "Reply with the fixture output.", model, plugins: [] };
`);
    const result = await output(spawn("a\nb\nc\n", ["--use", current.definition], current));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok1\nok3\n");
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
  instructions: "Reply with the fixture output.",
  model,
  plugins: [definePlugin({
    name: "echo",
    toolkit: Toolkit.make(echo),
    handlers: { echo: ({ text }) => Effect.succeed(text) },
  })],
};
`);
    const result = await output(spawn("hello\n", ["--use", current.definition], current));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("[tool echo]");
    expect(result.stdout).toContain("[tool echo completed]");
    expect(result.stdout).toContain("done");
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
    const incompatibleCore = await output(spawn("", ["--use", mismatch.definition], mismatch));
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
    const child = spawn("hello\n", ["--use", current.definition], current);
    const reader = child.stdout.setEncoding("utf8")[Symbol.asyncIterator]();
    const first = await reader.next();
    if (first.done) throw new Error("Missing first output");
    const firstOutput = first.value;
    expect(firstOutput).toContain("first");
    expect(child.exitCode).toBeNull();

    const hostPid = Number(await readFile(signalProbe.pid, "utf8"));
    child.kill("SIGINT");
    for (let attempt = 0; !(await exists(signalProbe.cleanupStarted)); attempt += 1) {
      if (attempt === 100) throw new Error("Session cleanup did not start");
      await delay(5);
    }
    process.kill(hostPid, "SIGINT");
    const tail = await rest(reader);
    expect(await exited(child)).toBe(130);
    expect(await exists(signalProbe.cleanupDone)).toBe(true);
    expect(firstOutput + tail).not.toContain(" second");
  });

  test("approves, denies, defaults, and EOF-denies pending Tool execution", async () => {
    const run = async (answer: string | undefined) => {
      const current = await fixture();
      const marker = join(current.root, "handler-ran");
      await writeFile(current.definition, approvalDefinitionSource(marker));
      const process = spawnInteractive(["--use", current.definition], current);
      const reader = process.stdout.setEncoding("utf8")[Symbol.asyncIterator]();
      process.stdin.write("hello\n");
      const initial = await readUntil(reader, "[approval dangerous]");
      if (answer === undefined) process.stdin.end();
      else process.stdin.end(answer);
      const [tail, stderr, exitCode] = await Promise.all([
        rest(reader),
        text(process.stderr),
        exited(process),
      ]);
      return {
        current,
        marker,
        stdout: initial + tail,
        stderr,
        exitCode,
        ran: await exists(marker),
      };
    };

    const approved = await run("y\n");
    expect(approved).toMatchObject({ exitCode: 0, stderr: "", ran: true });
    expect(approved.stdout).toContain("action: 'delete'");
    expect(approved.stdout).toContain("continued");

    for (const answer of ["n\n", "\n", undefined]) {
      const denied = await run(answer);
      expect(denied).toMatchObject({ exitCode: 0, stderr: "", ran: false });
      expect(denied.stdout).toContain("[approval dangerous]");
      // Denial lets the Turn continue: the second model step still streams.
      expect(denied.stdout).toContain("continued");
    }
  });

  test("interrupts while a Tool approval is pending", async () => {
    const current = await fixture();
    const marker = join(current.root, "handler-ran");
    await writeFile(current.definition, approvalDefinitionSource(marker));
    const process = spawnInteractive(["--use", current.definition], current);
    const reader = process.stdout.setEncoding("utf8")[Symbol.asyncIterator]();
    process.stdin.write("hello\n");
    await readUntil(reader, "[approval dangerous]");
    process.kill("SIGINT");
    await expect(exited(process)).resolves.toBe(130);
    expect(await exists(marker)).toBe(false);
  });

  test("initializes a Definition and stores a masked Credential", async () => {
    const current = await scaffold("mitome-cli-");
    const config = join(current.env.XDG_CONFIG_HOME, "mitome");
    await mkdir(config, { recursive: true });
    const localPackages = join(current.root, "local-packages");
    const archives = new Map<string, Buffer>();
    for (const packageName of ["core", "openai", "sdk"] as const) {
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
          exports: { ".": "./dist/index.js" },
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
    const result = await output(spawn(`fixture-model\n${key}\n`, ["init"], current)).finally(
      () => new Promise<void>((done) => registry.close(() => done())),
    );
    expect(result).toMatchObject({ exitCode: 0 });
    // 3 packages × (metadata + tarball), pinned by the isolated fixture HOME.
    expect(requests).toHaveLength(6);
    expect(result.stdout + result.stderr).not.toContain(key);
    const definition = await readFile(join(config, "agent.ts"), "utf8");
    expect(definition).toContain('import { defineAgent } from "@mitome/sdk"');
    expect(definition).toContain('import { env, openai } from "@mitome/openai"');
    expect(definition).toContain('openai("fixture-model", env("OPENAI_API_KEY"))');
    expect(definition).toContain("plugins: []");
    expect(definition).not.toContain(key);
    expect(JSON.parse(await readFile(join(config, "package.json"), "utf8"))).toMatchObject({
      dependencies: {
        "@mitome/core": corePackage.version,
        "@mitome/openai": corePackage.version,
        "@mitome/sdk": corePackage.version,
      },
    });
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

  test("refuses to clobber an existing default Definition", async () => {
    const current = await fixture();
    const path = join(current.env.XDG_CONFIG_HOME, "mitome", "agent.ts");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "export default {};\n");
    const result = await output(spawn("fixture-model\n", ["init"], current));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("already exists");
    expect(await readFile(path, "utf8")).toBe("export default {};\n");
  });

  test("refuses to clobber a config package.json without a Definition", async () => {
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

  test("init skips the Credential prompt when the installer fails", async () => {
    const current = await scaffold("mitome-cli-");
    const config = join(current.env.XDG_CONFIG_HOME, "mitome");
    await mkdir(config, { recursive: true });
    // Unroutable registry: bun install must fail before any Credential is collected.
    await writeFile(join(config, "bunfig.toml"), '[install]\nregistry = "http://127.0.0.1:1/"\n');
    const key = "synthetic-never-stored";
    const result = await output(spawn(`fixture-model\n${key}\n`, ["init"], current));
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain(key);
    expect(await exists(join(config, ".env"))).toBe(false);
  });

  test("init requires a non-blank model identifier", async () => {
    const current = await scaffold("mitome-cli-");
    const result = await output(spawn("   \n", ["init"], current));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("OpenAI model identifier is required.");
    expect(await exists(join(current.env.XDG_CONFIG_HOME, "mitome", "agent.ts"))).toBe(false);
  });

  test("auth delegates to the Definition credential descriptor without exposing Credentials", async () => {
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
    expect(result.stderr).toContain("Usage: mitome auth <login|logout>");
  });

  test("auth delegates generic OAuth capabilities without a provider registry", async () => {
    const current = await fixture();
    const capability = join(current.root, "capability.mjs");
    const marker = join(current.root, "capability-calls");
    await writeFile(
      capability,
      `import { appendFile } from "node:fs/promises"; export const authenticate = async ({ operation, input }) => appendFile(${JSON.stringify(marker)}, operation + ":" + (operation === "login" ? await input() : "logout") + "\\n");`,
    );
    await writeFile(
      current.definition,
      `import { Layer, Stream } from "effect";
import { LanguageModel, Response } from "effect/unstable/ai";
import { makeModel } from "@mitome/core";
const model = makeModel(Layer.succeed(LanguageModel.LanguageModel, { streamText: () => Stream.succeed(Response.makePart("text-delta", { id: "fixture", delta: "unused" })) }), { capability: { module: ${JSON.stringify(new URL(`file://${capability}`).href)}, provider: "fixture" } });
export default { instructions: "", model, plugins: [] };`,
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
    expect(await readFile(marker, "utf8")).toBe(
      "login:http://localhost:1455/auth/callback?code=ac_9rn3xKq&state=deadbeef\nlogout:logout\n",
    );
    // The synthetic authorization code must never appear in the CLI source: the
    // CLI has no provider branch and never sees OAuth payloads.
    const source = await readFile(join(packageDir, "src", "index.ts"), "utf8");
    expect(source).not.toContain(["code", "x"].join(""));
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

  test("auth login without a Definition directs users to init", async () => {
    const current = await fixture();
    const result = await output(spawn("", ["auth", "login"], current));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("run mitome init first");
    expect(result.stderr).not.toContain("Definition not found");
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
    expect(result.stderr).toBe("Definition Model does not support CLI authentication.\n");
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
