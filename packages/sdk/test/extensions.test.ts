import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Stream } from "effect";
import { Response } from "effect/unstable/ai";
import { createSession } from "@mitome/core";
import { defineExtension } from "../src/index.js";
import {
  type InstructionFilesOptions,
  instructionFiles,
  instructions,
} from "../src/extensions/index.js";
import { makeTestProvider } from "./provider.js";

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
  makeTestProvider(() =>
    Stream.succeed(Response.makePart("text-delta", { id: "test", delta: "done" })),
  );

describe("@mitome/sdk/extensions", () => {
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
              defineExtension({ instructions: "Third." }),
              instructionFiles({ base: import.meta.url, paths: ["./fixtures/instructions.md"] }),
              instructionFiles({ base: import.meta.url, paths: ["./fixtures/instructions.md"] }),
            ],
          }),
          (session) => session.history(),
        ),
      ),
    );

    expect(history).toMatchObject([
      {
        role: "system",
        content:
          "First.\n\nSecond.\n\nThird.\n\nSibling instructions.\n\n\nSibling instructions.\n",
      },
    ]);
  });

  test("resolves relative paths against the base module URL", () => {
    expect(
      instructionFiles({ base: import.meta.url, paths: ["./fixtures/instructions.md"] }),
    ).toEqual({
      instructions: "Sibling instructions.\n",
    });
  });

  test("resolves relative paths for a wrapping helper against the base it forwards", () => {
    const fromModule = (base: string, ...paths: Array<string>) => instructionFiles({ base, paths });
    // A module URL in a different directory than this test; only the forwarded base can find the file.
    const definingModule = new URL("./fixtures/agent.ts", import.meta.url).href;

    expect(fromModule(definingModule, "./instructions.md")).toEqual({
      instructions: "Sibling instructions.\n",
    });
  });

  test("reads absolute paths without a base", () => {
    // SAFETY: fileURLToPath returns an absolute path; only a literal proves that statically, and
    // extension.types.ts covers the literal contract.
    const absolute = fileURLToPath(
      new URL("./fixtures/instructions.md", import.meta.url),
    ) as `/${string}`;

    expect(instructionFiles({ paths: [absolute] })).toEqual({
      instructions: "Sibling instructions.\n",
    });
  });

  test("rejects a relative path without a base at runtime", () => {
    // SAFETY: stands in for a JavaScript caller that the type contract cannot reach.
    const untyped = JSON.parse(
      '{"paths":["./fixtures/instructions.md"]}',
    ) as InstructionFilesOptions;

    expect(() => instructionFiles(untyped)).toThrow(
      "instructionFiles() needs `base` to resolve a relative path: ./fixtures/instructions.md",
    );
  });

  test("resolves relative paths from a bundled defining module", () => {
    const root = temporaryDirectory();
    const entry = join(root, "agent.ts");
    const bundle = join(root, "agent.mjs");
    writeFileSync(join(root, "instructions.md"), "Bundled instructions.");
    writeFileSync(
      entry,
      `import { instructionFiles } from ${JSON.stringify(fileURLToPath(new URL("../src/extensions/index.ts", import.meta.url)))};\nconsole.log(JSON.stringify(instructionFiles({ base: import.meta.url, paths: ["./instructions.md"] })));\n`,
    );
    execFileSync("bun", ["build", entry, "--outfile", bundle, "--target", "node"]);

    expect(JSON.parse(execFileSync(process.execPath, [bundle], { encoding: "utf8" }))).toEqual({
      instructions: "Bundled instructions.",
    });
  });

  test("does not load an explicit file again when discovery finds it", () => {
    process.chdir(fileURLToPath(new URL("./fixtures", import.meta.url)));

    expect(
      instructionFiles({
        base: import.meta.url,
        paths: ["./fixtures/instructions.md"],
        discover: ["instructions.md"],
      }),
    ).toEqual({
      instructions: "Sibling instructions.\n",
    });
  });

  test("fails synchronously with the resolved path for a missing explicit file", () => {
    expect(() =>
      instructionFiles({ base: import.meta.url, paths: ["./fixtures/missing.md"] }),
    ).toThrow(/fixtures[\\/]missing\.md/);
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
});
