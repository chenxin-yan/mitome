import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import rootPackage from "../../../package.json" with { type: "json" };
import {
  customModel,
  defaultAgentPlan,
  defaultAgentPlanFiles,
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
  test("defines the default Agent scaffold and discovery as plan data", () => {
    const plan = defaultAgentPlan({ provider: "openai-codex", model: "gpt-5.6" });

    expect([...plan.keys()]).toEqual([...defaultAgentPlanFiles]);
    expect(plan.get("index.ts")).toContain('from "@mitome/sdk";');
    expect(plan.get("index.ts")).toContain('model: "openai-codex/gpt-5.6"');
    expect(plan.get("index.ts")).toContain(
      'instructionFiles({ paths: ["./AGENTS.md"], discover: ["AGENTS.md"] })',
    );
    expect(plan.get("AGENTS.md")).toBe("You are a helpful Agent.\n");
    expect(JSON.parse(plan.get("package.json")!)).toMatchObject({
      name: "mitome-agent",
      private: true,
      type: "module",
    });
  });

  test("defines the project-only files and Effect template as plan data", () => {
    const plan = projectPlan({ flavor: "effect", provider: "openai", model: "gpt-5.6" });

    expect([...plan.keys()]).toEqual([
      "package.json",
      "index.ts",
      "instructions.md",
      "tsconfig.json",
      ".gitignore",
      "README.md",
    ]);
    expect(plan.get("index.ts")).toContain('instructionFiles({ paths: ["./instructions.md"] })');
    expect(plan.get("instructions.md")).toBe("You are a helpful Agent.\n");
    expect(JSON.parse(plan.get("package.json")!)).toMatchObject({
      dependencies: { effect: rootPackage.workspaces.catalog.effect },
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
    expect(plan.get("README.md")).toContain("mitome auth login --use .\n");
    expect(plan.get("README.md")).toContain('mitome "hi" --use .\n');
  });

  test.each([
    [
      "default Agent",
      () => defaultAgentPlan({ provider: "openai", model: "gpt-5.6" }),
      "AGENTS.md",
      "index.ts",
    ],
    [
      "project",
      () => projectPlan({ flavor: "promise", provider: "openai", model: "gpt-5.6" }),
      "instructions.md",
      "package.json",
    ],
  ] as const)(
    "names an existing file before writing any %s scaffold file",
    async (_name, plan, existingFile, unwrittenFile) => {
      const path = await directory();
      const existing = join(path, existingFile);
      await writeFile(existing, "hand-written\n");

      await expect(writeScaffold(path, plan())).rejects.toThrow(`${existing} already exists`);
      expect(existsSync(join(path, unwrittenFile))).toBe(false);
      expect(await readFile(existing, "utf8")).toBe("hand-written\n");
    },
  );

  test("refuses a dangling symlink instead of writing through it", async () => {
    const path = await directory();
    const link = join(path, "index.ts");
    const target = join(path, "elsewhere.ts");
    await symlink(target, link);

    await expect(
      writeScaffold(path, projectPlan({ flavor: "promise", provider: "openai", model: "gpt-5.6" })),
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
  const variants = [
    ["promise", "openai", "@mitome/sdk", "openai()"],
    ["promise", "openai-codex", "@mitome/sdk", "codex()"],
    ["effect", "openai", "@mitome/sdk/effect", "openai()"],
    ["effect", "openai-codex", "@mitome/sdk/effect", "codex()"],
  ] as const;
  const embedExample = (readme: string) => /```ts\n([\s\S]*?)\n```/.exec(readme)![1]!;

  test("every project variant, its README embed example, and the default Agent typecheck against the workspace SDK", async () => {
    const root = await directory();
    // Generated projects resolve @mitome/*, effect, and @types/node like an installed consumer
    // would; this package's devDependencies stand in for the install.
    await symlink(join(packageDirectory, "node_modules"), join(root, "node_modules"), "dir");

    for (const [flavor, provider, sdk, factory] of variants) {
      const plan = projectPlan({ flavor, provider, model: "gpt-5.6" });
      const path = join(root, `${flavor}-${provider}`);
      await writeScaffold(path, plan);
      await writeFile(join(path, "embed.ts"), embedExample(plan.get("README.md")!));

      const dependencies = {
        "@mitome/providers": packageJson.version,
        "@mitome/sdk": packageJson.version,
      };
      if (flavor === "effect") {
        Object.assign(dependencies, { effect: rootPackage.workspaces.catalog.effect });
      }
      expect(JSON.parse(await contents(path, "package.json"))).toEqual({
        name: "mitome-agent",
        private: true,
        type: "module",
        dependencies,
      });
      const agent = await contents(path, "index.ts");
      expect(agent).toContain(`from "${sdk}";`);
      expect(agent).toContain(`providers: [${factory}]`);
      expect(agent).toContain(`model: "${provider}/gpt-5.6"`);
    }
    await writeScaffold(
      join(root, "default-agent"),
      defaultAgentPlan({ provider: "openai", model: "gpt-5.6" }),
    );
    // One program over every generated module, using the tsconfig a project ships with.
    await writeFile(
      join(root, "tsconfig.json"),
      projectPlan({ flavor: "promise", provider: "openai", model: "gpt-5.6" }).get(
        "tsconfig.json",
      )!,
    );

    const tsc = promisify(execFile)(join(packageDirectory, "node_modules/.bin/tsc"), [
      "-p",
      join(root, "tsconfig.json"),
    ]);
    await expect(tsc).resolves.toMatchObject({ stdout: "" });
  }, 60_000);
});
