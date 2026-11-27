// @module-tag dist
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "@effect/vitest";
import { compilerOutput } from "../support/compiler.js";

const packageDirectory = fileURLToPath(new URL("../..", import.meta.url));
const tsc = join(
  dirname(createRequire(import.meta.url).resolve("typescript/package.json")),
  "bin",
  "tsc",
);

// A consumer module importing the built package, as an author publishing an Agent would, and the
// layer under an Agent from its own subpath.
const consumer = `import { Agent } from "@mitome/core";
import { Session } from "@mitome/core/kernel";
export const basic = Agent.make({});
export const brief = Agent.make({ ...basic, instructions: "Be brief." });
export const raw = Session.make;
`;

const tsconfig = {
  compilerOptions: {
    declaration: true,
    emitDeclarationOnly: true,
    outDir: "out",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    target: "ES2022",
    strict: true,
    exactOptionalPropertyTypes: true,
    skipLibCheck: true,
    types: [],
  },
  files: ["consumer.ts"],
};

describe("declarations of a consumer of the built package", () => {
  it("name the type of an Agent without a program", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mitome-consumer-"));
    try {
      await mkdir(join(directory, "node_modules", "@mitome"), { recursive: true });
      await symlink(
        packageDirectory,
        join(directory, "node_modules", "@mitome", "core"),
        "junction",
      );
      await writeFile(join(directory, "consumer.ts"), consumer);
      await writeFile(join(directory, "tsconfig.json"), JSON.stringify(tsconfig));
      // tsc prints diagnostics on stdout, which the rejection's own message leaves out.
      await promisify(execFile)(process.execPath, [tsc, "-p", directory]).catch(
        (cause: unknown) => {
          throw new Error(`tsc failed:\n${compilerOutput(cause)}`);
        },
      );
      const declarations = await readFile(join(directory, "out", "consumer.d.ts"), "utf8");
      expect(declarations).toContain("export declare const brief");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
