import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { scaffold } from "../src/index.js";

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
