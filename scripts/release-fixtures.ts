import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const rootDirectory = resolve(import.meta.dir, "..");
const publicPackages = ["core", "sdk", "providers", "cli"] as const;
const packageVersion: string = (
  await Bun.file(join(rootDirectory, "packages", "core", "package.json")).json()
).version;
const temporaryDirectory = await mkdtemp(join(tmpdir(), "mitome-release-fixtures-"));
const archivesDirectory = join(temporaryDirectory, "archives");
const consumerDirectory = join(temporaryDirectory, "consumer");

const run = async (command: ReadonlyArray<string>, cwd = rootDirectory): Promise<void> => {
  const child = Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit" });
  if ((await child.exited) !== 0) throw new Error(`Command failed: ${command.join(" ")}`);
};

const archiveFor = async (name: string): Promise<string> => {
  const files = await readdir(archivesDirectory);
  const archive = files.find((file) => file === `mitome-${name}-${packageVersion}.tgz`);
  if (archive === undefined) throw new Error(`Missing ${name} tarball.`);
  return join(archivesDirectory, archive);
};

try {
  for (const name of publicPackages) {
    // The root LICENSE is the single source; tarballs need a per-package copy.
    await cp(join(rootDirectory, "LICENSE"), join(rootDirectory, "packages", name, "LICENSE"));
    await run(
      [process.execPath, "pm", "pack", "--destination", archivesDirectory, "--ignore-scripts"],
      join(rootDirectory, "packages", name),
    );
  }

  const storeDirectory = join(rootDirectory, "node_modules", ".bun");
  const effectVersion: string = (await Bun.file(join(rootDirectory, "package.json")).json())
    .workspaces.catalog.effect;
  const installedPackage = (name: string, version: string): string => {
    // The store can hold several versions on dev machines; pin to the catalog one.
    const entry = [
      ...new Bun.Glob(`**/node_modules/${name}/package.json`).scanSync({ cwd: storeDirectory }),
    ].find((candidate) => candidate.includes(`${name}@${version}`));
    if (entry === undefined) throw new Error(`Cannot find installed ${name}@${version}.`);
    return dirname(join(storeDirectory, entry));
  };
  const dependencies = Object.fromEntries(
    await Promise.all(
      publicPackages.map(async (name) => [`@mitome/${name}`, `file:${await archiveFor(name)}`]),
    ),
  );
  const nodeModules = join(consumerDirectory, "node_modules");
  await mkdir(consumerDirectory, { recursive: true });
  await Bun.write(
    join(consumerDirectory, "package.json"),
    JSON.stringify({
      name: "release-fixture",
      private: true,
      dependencies: { ...dependencies, effect: "file:../vendor/effect" },
      // effect must also be overridden: @effect/ai-openai(-compat) resolve their
      // own copy otherwise, and two effect instances break Redacted/ServiceMap
      // identity at runtime.
      overrides: { ...dependencies, effect: "file:../vendor/effect" },
    }),
  );
  await cp(
    installedPackage("effect", effectVersion),
    join(temporaryDirectory, "vendor", "effect"),
    {
      recursive: true,
      dereference: true,
    },
  );
  // Platform binary packages are release-time artifacts; the fixture gates
  // the JS packages, so skip the (unpublished) optional dependencies.
  await run([process.execPath, "install", "--omit=optional"], consumerDirectory);
  if (!(await Bun.file(join(nodeModules, ".bin", "mitome")).exists())) {
    throw new Error("Bun install did not link the CLI launcher.");
  }
  for (const name of publicPackages) {
    const destination = join(nodeModules, "@mitome", name);
    await mkdir(destination, { recursive: true });
    await run(["tar", "-xzf", await archiveFor(name), "-C", destination, "--strip-components=1"]);
    const manifest = await Bun.file(join(destination, "package.json")).json();
    if (/"(?:catalog|workspace):/.test(JSON.stringify(manifest))) {
      throw new Error(`${name} tarball retains a workspace-only dependency protocol.`);
    }
  }
  await writeFile(
    join(consumerDirectory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "esnext",
        module: "esnext",
        moduleResolution: "bundler",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
      },
      files: ["smoke.ts"],
    }),
  );
  await writeFile(
    join(consumerDirectory, "smoke.ts"),
    `import { Effect, Layer, Stream } from "effect";
import { LanguageModel, Response } from "effect/unstable/ai";
import { createSession, makeModel } from "@mitome/core";
import { defineAgent, withSession } from "@mitome/sdk";
import { env, openai } from "@mitome/providers/openai";
import { openaiCompatible } from "@mitome/providers/openai-compatible";
import { codex, oauth } from "@mitome/providers/openai-codex";

declare const process: { env: Record<string, string | undefined> };
process.env.OPENAI_API_KEY = "fixture";
const provider = openai("fixture", env("OPENAI_API_KEY"));
if (typeof openaiCompatible !== "function") throw new Error("OpenAI-compatible package was not installed.");
await Effect.runPromise(Effect.scoped(Effect.as(createSession(defineAgent({ instructions: "", model: provider, plugins: [] })), undefined)));
const credential = oauth();
if (typeof codex !== "function" || typeof credential === "string" || typeof credential.capability.module !== "string") throw new Error("Codex package was not installed.");
// Deliberately partial mock; only streamText runs in this smoke.
const model = makeModel(Layer.succeed(LanguageModel.LanguageModel, {
  streamText: () => Stream.succeed(Response.makePart("text-delta", { id: "fixture", delta: "ok" })),
} as unknown as LanguageModel.Service));
const definition = defineAgent({ instructions: "", model, plugins: [] });
if (definition.model !== model) throw new Error("SDK wrapped the canonical Core Model.");
const events = await withSession(definition, async (session) => {
  const values = [];
  for await (const event of session.prompt("hello")) values.push(event);
  return values;
});
if (events.at(-1)?.type !== "response-complete") throw new Error("Session smoke did not complete.");
`,
  );
  // Typechecking the consumer against the packed declarations is the leak gate:
  // it fails if any published .d.ts references types the tarballs cannot resolve.
  await run([process.execPath, "x", "tsc", "-p", join(consumerDirectory, "tsconfig.json")]);
  await run([process.execPath, "smoke.ts"], consumerDirectory);
  console.log("Release tarball/install fixtures passed.");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
