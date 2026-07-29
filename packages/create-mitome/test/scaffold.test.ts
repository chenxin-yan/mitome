import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { scaffold } from "../src/index.js";
import {
  customModel,
  defaultAgentPlan,
  defaultAgentPlanFiles,
  modelChoices,
  projectPlan,
  providerChoices,
  validateModelId,
  writeScaffold,
} from "../src/template.js";

const directories: Array<string> = [];
const directory = async () => {
  const path = await mkdtemp(join(tmpdir(), "create-mitome-"));
  directories.push(path);
  return path;
};

const contents = (path: string, file: string) => readFile(join(path, file), "utf8");

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("scaffold plans", () => {
  test("defines the default Agent scaffold and discovery as plan data", () => {
    const plan = defaultAgentPlan({ provider: "openai-codex", model: "gpt-5.6" });

    expect([...plan.keys()]).toEqual(["index.ts", "AGENTS.md", "package.json"]);
    expect([...plan.keys()]).toEqual([...defaultAgentPlanFiles]);
    expect(plan.get("index.ts")).toContain('import { defineAgent } from "@mitome/sdk";');
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
      "README.md",
    ]);
    expect(plan.get("index.ts")).toContain('import { defineAgent } from "@mitome/sdk/effect";');
    expect(plan.get("index.ts")).toContain('instructionFiles({ paths: ["./instructions.md"] })');
    expect(plan.get("instructions.md")).toBe("You are a helpful Agent.\n");
    expect(JSON.parse(plan.get("tsconfig.json")!)).toEqual({
      compilerOptions: {
        target: "ESNext",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
      },
      include: ["index.ts"],
    });
    expect(plan.get("README.md")).toContain("npm install effect");
    expect(plan.get("README.md")).toContain("createSession");
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
      "README.md",
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
});

describe("selection policy", () => {
  test("defines Provider and Model choices with a custom-Model escape", () => {
    expect(providerChoices).toEqual([
      { label: "OpenAI API", value: "openai" },
      { label: "OpenAI Codex (ChatGPT)", value: "openai-codex" },
    ]);
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

describe("create-mitome scaffold", () => {
  test.each([
    ["promise", "openai", '@mitome/sdk";', "openai()", "openai"],
    ["promise", "openai-codex", '@mitome/sdk";', "codex()", "openai-codex"],
    ["effect", "openai", '@mitome/sdk/effect";', "openai()", "openai"],
    ["effect", "openai-codex", '@mitome/sdk/effect";', "codex()", "openai-codex"],
  ] as const)("creates a %s %s Agent project", async (flavor, provider, sdk, factory, id) => {
    const path = await directory();
    await scaffold(path, { flavor, provider, model: "gpt-5.6" });

    expect(JSON.parse(await contents(path, "package.json"))).toEqual({
      name: "mitome-agent",
      private: true,
      type: "module",
      dependencies: {
        "@mitome/plugins": "0.0.0",
        "@mitome/providers": "0.0.0",
        "@mitome/sdk": "0.0.0",
      },
    });
    const agent = await contents(path, "index.ts");
    expect(agent).toContain(`import { defineAgent } from "${sdk}`);
    expect(agent).toContain(`providers: [${factory}]`);
    expect(agent).toContain(`model: "${id}/gpt-5.6"`);
    expect(agent).not.toContain("env(");
    expect(agent).toContain('import { instructionFiles } from "@mitome/plugins";');
    expect(agent).toContain('plugins: [instructionFiles({ paths: ["./instructions.md"] })]');
    expect(agent).not.toContain('instructions: "You are a helpful Agent."');
    expect(await contents(path, "instructions.md")).toBe("You are a helpful Agent.\n");
    expect(JSON.parse(await contents(path, "tsconfig.json")).include).toEqual(["index.ts"]);
  });

  test("creates an Effect-native Codex project without overwriting files", async () => {
    const path = await directory();

    await scaffold(path, { flavor: "effect", provider: "openai-codex", model: "gpt-5.6" });

    expect(await contents(path, "index.ts")).toContain(
      'import { defineAgent } from "@mitome/sdk/effect";',
    );
    expect(await contents(path, "index.ts")).toContain(
      'import { codex } from "@mitome/providers/openai-codex";',
    );
    const readme = await contents(path, "README.md");
    expect(readme).toContain("npm install effect");
    expect(readme).toContain("createSession");
    expect(readme).toContain("mitome auth login --use .\n");
    expect(readme).toContain('mitome "hi" --use .\n');

    await writeFile(join(path, "index.ts"), "hand-written\n");
    await expect(
      scaffold(path, { flavor: "promise", provider: "openai", model: "gpt-5.6" }),
    ).rejects.toThrow("package.json already exists");
    expect(await contents(path, "index.ts")).toBe("hand-written\n");
  });

  test("refuses to overwrite instructions.md", async () => {
    const path = await directory();
    await writeFile(join(path, "instructions.md"), "hand-written\n");

    await expect(
      scaffold(path, { flavor: "promise", provider: "openai", model: "gpt-5.6" }),
    ).rejects.toThrow("instructions.md already exists");
  });
});
