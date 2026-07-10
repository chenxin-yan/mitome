import { spawn as spawnChild } from "node:child_process";
import { createRequire } from "node:module";
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
  const child = spawnChild(binary, args, {
    cwd: current.root,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(input);
  return child;
};

const exited = (child: ReturnType<typeof spawn>) => {
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
