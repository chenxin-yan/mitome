import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Stream } from "effect";
import { LanguageModel, Response } from "effect/unstable/ai";
import { createSession, makeProvider } from "@mitome/core";
import { defineAgent as definePromiseAgent } from "../src/index.js";
import { defineAgent as defineEffectAgent } from "../src/effect.js";
import { instructionFiles, instructions } from "../src/extensions/index.js";

const cwd = process.cwd();
const temporaryDirectories: Array<string> = [];

afterEach(() => {
  process.chdir(cwd);
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true });
});

const temporaryDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "mitome-extensions-"));
  temporaryDirectories.push(directory);
  return directory;
};

const provider = () =>
  makeProvider("test", [] as const, undefined, () =>
    Layer.effect(
      LanguageModel.LanguageModel,
      LanguageModel.make({
        generateText: () => Effect.succeed([]),
        streamText: () =>
          Stream.succeed(Response.makePart("text-delta", { id: "test", delta: "done" })),
      }),
    ),
  );

describe("@mitome/sdk/extensions", () => {
  test("uses inline Instructions as the Session system message", async () => {
    const history = await Effect.runPromise(
      Effect.scoped(
        Effect.map(
          createSession({
            providers: [provider()],
            model: "test/default",
            extensions: [instructions("Be helpful.")],
          }),
          (session) => session.history(),
        ),
      ),
    );

    expect(history).toMatchObject([{ role: "system", content: "Be helpful." }]);
  });

  test("composes multiple unnamed instruction Extensions", async () => {
    const history = await Effect.runPromise(
      Effect.scoped(
        Effect.map(
          createSession({
            providers: [provider()],
            model: "test/default",
            extensions: [
              instructions("First."),
              instructions("Second."),
              instructionFiles({ paths: ["./fixtures/instructions.md"] }),
              instructionFiles({ paths: ["./fixtures/instructions.md"] }),
            ],
          }),
          (session) => session.history(),
        ),
      ),
    );

    expect(history).toMatchObject([
      {
        role: "system",
        content: "First.\n\nSecond.\n\nSibling instructions.\n\n\nSibling instructions.\n",
      },
    ]);
  });

  test("resolves explicit paths relative to the defining module", () => {
    expect(instructionFiles({ paths: ["./fixtures/instructions.md"] })).toEqual({
      instructions: "Sibling instructions.\n",
    });
  });

  test("resolves explicit paths from a bundled defining module", () => {
    const root = temporaryDirectory();
    const entry = join(root, "agent.ts");
    const bundle = join(root, "agent.mjs");
    writeFileSync(join(root, "instructions.md"), "Bundled instructions.");
    writeFileSync(
      entry,
      `import { instructionFiles } from ${JSON.stringify(fileURLToPath(new URL("../src/extensions/index.ts", import.meta.url)))};\nconsole.log(JSON.stringify(instructionFiles({ paths: ["./instructions.md"] })));\n`,
    );
    execFileSync("bun", ["build", entry, "--outfile", bundle, "--target", "node"]);

    expect(JSON.parse(execFileSync(process.execPath, [bundle], { encoding: "utf8" }))).toEqual({
      instructions: "Bundled instructions.",
    });
  });

  test("does not load an explicit file again when discovery finds it", () => {
    process.chdir(fileURLToPath(new URL("./fixtures", import.meta.url)));

    expect(
      instructionFiles({ paths: ["./fixtures/instructions.md"], discover: ["instructions.md"] }),
    ).toEqual({
      instructions: "Sibling instructions.\n",
    });
  });

  test("fails synchronously with the resolved path for a missing explicit file", () => {
    expect(() => instructionFiles({ paths: ["./fixtures/missing.md"] })).toThrow(
      /fixtures[\\/]missing\.md/,
    );
  });

  test("discovers all repository matches outermost-first", () => {
    const root = temporaryDirectory();
    const nested = join(root, "nested");
    const cwd = join(nested, "agent");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, "AGENTS.md"), "Root instructions.");
    writeFileSync(join(root, "RULES.md"), "Root rules.");
    writeFileSync(join(nested, "AGENTS.md"), "Nested instructions.");
    writeFileSync(join(nested, "RULES.md"), "Nested rules.");
    process.chdir(cwd);

    expect(instructionFiles({ discover: ["AGENTS.md", "RULES.md"] })).toEqual({
      instructions: "Root instructions.\n\nRoot rules.\n\nNested instructions.\n\nNested rules.",
    });
  });

  test("skips absent discovered names and only searches the cwd outside a repository", () => {
    const outside = temporaryDirectory();
    const cwd = join(outside, "child");
    mkdirSync(cwd);
    writeFileSync(join(outside, "AGENTS.md"), "Parent instructions.");
    writeFileSync(join(cwd, "LOCAL.md"), "Cwd instructions.");
    process.chdir(cwd);

    expect(instructionFiles({ discover: ["AGENTS.md"] })).toEqual({});
    expect(instructionFiles({ discover: ["LOCAL.md"] })).toEqual({
      instructions: "Cwd instructions.",
    });
  });

  test("rejects discovered values that are not bare filenames", () => {
    expect(() => instructionFiles({ discover: ["nested/AGENTS.md"] })).toThrow(
      "Discovered instruction file must be a bare filename: nested/AGENTS.md",
    );
    expect(() => instructionFiles({ discover: [".."] })).toThrow(
      "Discovered instruction file must be a bare filename: ..",
    );
  });

  test("accepts Extensions from both SDK definition surfaces", () => {
    const promiseDefinition = definePromiseAgent({
      providers: [provider()],
      model: "test/default",
      extensions: [instructions("Promise SDK")],
    });
    const effectDefinition = defineEffectAgent({
      providers: [provider()],
      model: "test/default",
      extensions: [instructionFiles({ paths: ["./fixtures/instructions.md"] })],
    });

    expect(promiseDefinition.extensions[0].instructions).toBe("Promise SDK");
    expect(effectDefinition.extensions[0].instructions).toBe("Sibling instructions.\n");
  });
});
