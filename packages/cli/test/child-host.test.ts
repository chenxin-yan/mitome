import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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

// child-host.ts uses Bun-only APIs, so exercise it inside a real Bun child.
test("runEmbeddedHost forwards dispatch inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "mitome-host-"));
  temporaryDirectories.push(root);
  const definition = join(root, "agent", "definition.ts");
  await mkdir(dirname(definition), { recursive: true });

  const source =
    "console.log(JSON.stringify({ path: process.argv[1], prompt: process.argv[2], mode: process.argv[3] }));";
  const driver = [
    `import { runEmbeddedHost } from ${JSON.stringify(childHostModule)};`,
    `process.exitCode = await runEmbeddedHost(${JSON.stringify(source)}, ${JSON.stringify(definition)}, undefined, "auto");`,
  ].join("\n");
  const child = spawn("bun", ["--no-env-file", "--eval", driver], {
    env: { ...process.env, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "xdg") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [stdout, stderr] = await Promise.all([text(child.stdout), text(child.stderr)]);
  const exitCode = await new Promise((done) => child.once("exit", done));

  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  expect(JSON.parse(stdout)).toStrictEqual({
    path: definition,
    prompt: "",
    mode: "auto",
  });
});
