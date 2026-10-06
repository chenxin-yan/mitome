import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import rootPackage from "../../../package.json" with { type: "json" };
import { knownModelIds } from "../src/model-hints.js";
import {
  customModel,
  modelChoices,
  projectPlan,
  validateModelId,
  writeScaffold,
} from "../src/template.js";

const directories: Array<string> = [];
const directory = async () => {
  const path = await mkdtemp(join(tmpdir(), "create-mitome-"));
  directories.push(path);
  return path;
};

const packageDirectory = join(import.meta.dirname, "..");
const contents = (path: string, file: string) => readFile(join(path, file), "utf8");

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("scaffold plans", () => {
  test("defines the native Agent program and project files as plan data", () => {
    const plan = projectPlan({ provider: "openai", model: "gpt-5.6" });

    expect([...plan.keys()]).toEqual([
      "package.json",
      "index.ts",
      "tsconfig.json",
      ".gitignore",
      "README.md",
    ]);
    expect(plan.get("index.ts")).toContain('from "@mitome/core";');
    expect(plan.get("index.ts")).toContain("session.run(agent(");
    expect(plan.get("index.ts")).toContain('providerModel(openai(), "gpt-5.6")');
    expect(JSON.parse(plan.get("package.json")!)).toEqual({
      name: "mitome-agent",
      private: true,
      type: "module",
      dependencies: {
        "@mitome/core": packageJson.version,
        "@mitome/providers": packageJson.version,
        effect: rootPackage.workspaces.catalog.effect,
      },
    });
    expect(JSON.parse(plan.get("tsconfig.json")!)).toEqual({
      compilerOptions: {
        target: "ESNext",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: ["**/*.ts"],
    });
    expect(plan.get(".gitignore")).toBe("node_modules/\n");
    expect(plan.get("README.md")).toContain("OPENAI_API_KEY");
    expect(plan.get("README.md")).toContain("node index.ts\n");
  });

  test("names an existing file before writing any scaffold file", async () => {
    const path = await directory();
    const existing = join(path, "index.ts");
    await writeFile(existing, "hand-written\n");

    await expect(
      writeScaffold(path, projectPlan({ provider: "openai", model: "gpt-5.6" })),
    ).rejects.toThrow(`${existing} already exists`);
    expect(existsSync(join(path, "package.json"))).toBe(false);
    expect(await readFile(existing, "utf8")).toBe("hand-written\n");
  });

  test("refuses a dangling symlink instead of writing through it", async () => {
    const path = await directory();
    const link = join(path, "index.ts");
    const target = join(path, "elsewhere.ts");
    await symlink(target, link);

    await expect(
      writeScaffold(path, projectPlan({ provider: "openai", model: "gpt-5.6" })),
    ).rejects.toThrow(`${link} already exists`);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(target);
    expect(existsSync(target)).toBe(false);
  });
});

describe("selection policy", () => {
  test("appends a custom-Model escape to known Model choices", () => {
    expect(modelChoices(["known-model"])).toEqual([
      { label: "known-model", value: "known-model" },
      { label: "Custom model ID", value: customModel },
    ]);
  });

  test("trims custom Model ids and rejects empty input", () => {
    expect(validateModelId("  private-model  ")).toBe("private-model");
    expect(validateModelId("   ")).toBeUndefined();
  });
});

describe("generated TypeScript", () => {
  test("every Provider variant typechecks against the workspace packages", async () => {
    const root = await directory();
    // Generated projects resolve @mitome/*, effect, and @types/node like an installed consumer
    // would; this package's devDependencies stand in for the install.
    await symlink(join(packageDirectory, "node_modules"), join(root, "node_modules"), "dir");

    for (const [provider, factory] of [
      ["openai", "openai()"],
      ["openai-codex", "codex()"],
    ] as const) {
      const path = join(root, provider);
      await writeScaffold(path, projectPlan({ provider, model: "gpt-5.6" }));
      expect(await contents(path, "index.ts")).toContain(`providerModel(${factory}, "gpt-5.6")`);
    }
    // One program over every generated module, using the tsconfig a project ships with.
    await writeFile(
      join(root, "tsconfig.json"),
      projectPlan({ provider: "openai", model: "gpt-5.6" }).get("tsconfig.json")!,
    );

    const tsc = promisify(execFile)(join(packageDirectory, "node_modules/.bin/tsc"), [
      "-p",
      join(root, "tsconfig.json"),
    ]);
    await expect(tsc).resolves.toMatchObject({ stdout: "" });
  }, 60_000);
});

describe("create-mitome executable", () => {
  const executable = join(packageDirectory, "dist/index.js");
  const run = (args: ReadonlyArray<string>, input: string, cwd: string) =>
    new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [executable, ...args], { cwd });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
      child.stdin.end(input);
    });
  const customModelChoice = (provider: keyof typeof knownModelIds) =>
    knownModelIds[provider].length + 1;

  test("scaffolds the numbered selections into the directory argument", async () => {
    const path = await directory();

    const result = await run(["agent"], "2\n1\n", path);

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("Created a Mitome Agent in agent.");
    const agent = await contents(join(path, "agent"), "index.ts");
    expect(agent).toContain('from "@mitome/core";');
    expect(agent).toContain(
      `providerModel(codex(), ${JSON.stringify(knownModelIds["openai-codex"][0])})`,
    );
  });

  test("accepts a trimmed custom Model id", async () => {
    const path = await directory();

    const result = await run([], `1\n${customModelChoice("openai")}\n  my-model  \n`, path);

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(await contents(path, "index.ts")).toContain('providerModel(openai(), "my-model")');
  });

  test("defaults empty answers and re-asks after an out-of-range choice", async () => {
    const path = await directory();

    const result = await run([], "9\n\n\n", path);

    expect(result).toMatchObject({ exitCode: 0, stderr: "Choose 1-2.\n" });
    expect(await contents(path, "index.ts")).toContain(
      `providerModel(openai(), ${JSON.stringify(knownModelIds.openai[0])})`,
    );
  });

  test.each([
    ["closed input", "1\n", "Input closed"],
    ["blank custom Model id", `1\n${customModelChoice("openai")}\n   \n`, "Model ID is required"],
  ])("fails with exit code 1 and writes nothing on %s", async (_name, input, message) => {
    const path = await directory();

    const result = await run([], input, path);

    expect(result).toMatchObject({ exitCode: 1, stderr: `${message}\n` });
    expect(existsSync(join(path, "index.ts"))).toBe(false);
  });
});
