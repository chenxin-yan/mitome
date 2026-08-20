import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const childHostModule = resolve(dirname(fileURLToPath(import.meta.url)), "../src/child-host.ts");
const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

// child-host.ts uses Bun-only APIs (Bun.spawn, text imports), so the module is
// exercised inside a real Bun child rather than imported into the vitest runtime.
test("runEmbeddedHost resolves a bare preload specifier beside the Agent Definition", async () => {
  const root = await mkdtemp(join(tmpdir(), "mitome-preload-"));
  temporaryDirectories.push(root);
  const definition = join(root, "agent", "definition.ts");
  const probe = join(dirname(definition), "node_modules", "preload-probe");
  await mkdir(probe, { recursive: true });
  await writeFile(
    join(probe, "package.json"),
    JSON.stringify({ name: "preload-probe", version: "0.0.0", main: "index.js" }),
  );
  await writeFile(join(probe, "index.js"), "globalThis.__mitomePreloadProbe = true;\n");
  await writeFile(definition, "export default {};\n");
  // Run from an unrelated cwd so the specifier can only resolve beside the definition.
  const elsewhere = join(root, "elsewhere");
  await mkdir(elsewhere);

  const source =
    "console.log(JSON.stringify({ preloaded: globalThis.__mitomePreloadProbe === true, path: process.argv[1], prompt: process.argv[2] }));";
  const driver = [
    `import { runEmbeddedHost } from ${JSON.stringify(childHostModule)};`,
    `process.exitCode = await runEmbeddedHost(${JSON.stringify(source)}, ${JSON.stringify(definition)}, "probe prompt", "preload-probe");`,
  ].join("\n");
  const child = spawn("bun", ["--no-env-file", "--eval", driver], {
    cwd: elsewhere,
    env: { ...process.env, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "xdg") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [stdout, stderr] = await Promise.all([text(child.stdout), text(child.stderr)]);
  const exitCode = await new Promise((done) => child.once("exit", done));

  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  expect(JSON.parse(stdout)).toStrictEqual({
    preloaded: true,
    path: definition,
    prompt: "probe prompt",
  });
});
