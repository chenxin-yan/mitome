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
  test("creates a Promise-first OpenAI Agent project", async () => {
    const path = await directory();

    await scaffold(path, { flavor: "promise", provider: "openai", model: "gpt-5.6" });

    expect(JSON.parse(await contents(path, "package.json"))).toEqual({
      name: "mitome-agent",
      private: true,
      type: "module",
      dependencies: {
        "@mitome/providers": "0.0.0",
        "@mitome/sdk": "0.0.0",
      },
    });
    expect(await contents(path, "agent.ts")).toContain(
      'import { defineAgent } from "@mitome/sdk";',
    );
    expect(await contents(path, "agent.ts")).toContain('openai("gpt-5.6", env("OPENAI_API_KEY"))');
    expect(JSON.parse(await contents(path, "tsconfig.json"))).toMatchObject({
      include: ["agent.ts"],
    });
    expect(await contents(path, "README.md")).toContain('mitome "hi" --use ./agent.ts');
    expect(await contents(path, "README.md")).toContain("mitome auth login --use ./agent.ts");
    expect(await contents(path, "README.md")).toContain("withSession");
  });

  test("creates an Effect-native Codex project without overwriting files", async () => {
    const path = await directory();

    await scaffold(path, { flavor: "effect", provider: "openai-codex", model: "gpt-5.6" });

    expect(await contents(path, "agent.ts")).toContain(
      'import { defineAgent } from "@mitome/sdk/effect";',
    );
    expect(await contents(path, "agent.ts")).toContain(
      'import { codex } from "@mitome/providers/openai-codex";',
    );
    expect(await contents(path, "README.md")).toContain("npm install effect");
    expect(await contents(path, "README.md")).toContain("createSession");

    await writeFile(join(path, "agent.ts"), "hand-written\n");
    await expect(
      scaffold(path, { flavor: "promise", provider: "openai", model: "gpt-5.6" }),
    ).rejects.toThrow("package.json already exists");
    expect(await contents(path, "agent.ts")).toBe("hand-written\n");
  });
});
