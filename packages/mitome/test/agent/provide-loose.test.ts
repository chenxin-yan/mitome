import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "@effect/vitest";
import { compilerOutput } from "../support/compiler.js";

const project = fileURLToPath(new URL("loose/tsconfig.json", import.meta.url));
const tsc = join(
  dirname(createRequire(import.meta.url).resolve("typescript/package.json")),
  "bin",
  "tsc",
);

describe("Mitome.make in a consumer without exactOptionalPropertyTypes", () => {
  it("counts an undefined provide as providing nothing", async () => {
    // tsc prints diagnostics on stdout, which the rejection's own message leaves out. Any failure
    // fails the test, so that a compiler that did not run is not taken for a clean check.
    const { stdout } = await promisify(execFile)(process.execPath, [tsc, "-p", project]).catch(
      (cause: unknown) => {
        throw new Error(`tsc failed:\n${compilerOutput(cause)}`);
      },
    );
    expect(stdout).not.toContain("error TS");
  }, 60_000);
});
