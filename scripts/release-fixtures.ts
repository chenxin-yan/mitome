import { cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const rootDirectory = resolve(import.meta.dir, "..");
const publicPackages = ["core", "sdk", "providers", "tui", "cli", "create-mitome"] as const;
type PublicPackage = (typeof publicPackages)[number];
const packageName = (name: PublicPackage): string =>
  name === "create-mitome" ? name : `@mitome/${name}`;
const packageVersion: string = (
  await Bun.file(join(rootDirectory, "packages", "core", "package.json")).json()
).version;
const temporaryDirectory = await mkdtemp(join(tmpdir(), "mitome-release-fixtures-"));
const archivesDirectory = join(temporaryDirectory, "archives");
const consumerDirectory = join(temporaryDirectory, "consumer");

const run = async (
  command: ReadonlyArray<string>,
  cwd = rootDirectory,
  input?: string,
): Promise<void> => {
  const child = Bun.spawn([...command], {
    cwd,
    stdin: input === undefined ? "ignore" : "pipe",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (input !== undefined) {
    const stdin = child.stdin!;
    await stdin.write(input);
    await stdin.end();
  }
  if ((await child.exited) !== 0) throw new Error(`Command failed: ${command.join(" ")}`);
};

const archiveFor = async (name: PublicPackage): Promise<string> => {
  const files = await readdir(archivesDirectory);
  const stem = name === "create-mitome" ? name : `mitome-${name}`;
  const archive = files.find((file) => file === `${stem}-${packageVersion}.tgz`);
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
  for (const name of publicPackages) {
    const archive = await archiveFor(name);
    await run([process.execPath, "x", "publint", "--strict", archive]);
    if (name !== "cli") {
      await run([
        process.execPath,
        "x",
        "attw",
        "--profile",
        "esm-only",
        "--format",
        "table",
        "--no-color",
        archive,
      ]);
    }
  }

  const storeDirectory = join(rootDirectory, "node_modules", ".bun");
  const effectVersion: string = (await Bun.file(join(rootDirectory, "package.json")).json())
    .workspaces.catalog.effect;
  const installedPackage = async (name: string, version: string): Promise<string> => {
    // The store can hold several versions on dev machines; pin to the catalog one.
    for await (const entry of new Bun.Glob(`**/node_modules/${name}/package.json`).scan({
      cwd: storeDirectory,
    })) {
      const manifest: { version?: unknown } = await Bun.file(join(storeDirectory, entry)).json();
      if (manifest.version === version) return dirname(join(storeDirectory, entry));
    }
    throw new Error(`Cannot find installed ${name}@${version}.`);
  };
  const dependencies = Object.fromEntries(
    await Promise.all(
      publicPackages.map(async (name) => [packageName(name), `file:${await archiveFor(name)}`]),
    ),
  );
  const effectArchive = `file:../vendor/effect-${effectVersion}.tgz`;
  const nodeModules = join(consumerDirectory, "node_modules");
  await mkdir(consumerDirectory, { recursive: true });
  await Bun.write(
    join(consumerDirectory, "package.json"),
    JSON.stringify({
      name: "release-fixture",
      private: true,
      dependencies: { ...dependencies, effect: effectArchive },
      overrides: { ...dependencies, effect: effectArchive },
    }),
  );
  const effectDirectory = join(temporaryDirectory, "vendor", "effect");
  await cp(await installedPackage("effect", effectVersion), effectDirectory, {
    recursive: true,
    dereference: true,
  });
  await run(
    [process.execPath, "pm", "pack", "--destination", dirname(effectDirectory), "--ignore-scripts"],
    effectDirectory,
  );
  // Platform binary packages are release-time artifacts; the fixture gates
  // the JS packages, so skip the (unpublished) optional dependencies.
  await run([process.execPath, "install", "--omit=optional"], consumerDirectory);
  for (const bin of ["mitome", "create-mitome"]) {
    if (!(await Bun.file(join(nodeModules, ".bin", bin)).exists())) {
      throw new Error(`Bun install did not link the ${bin} launcher.`);
    }
  }
  for (const name of publicPackages) {
    const destination =
      name === "create-mitome" ? join(nodeModules, name) : join(nodeModules, "@mitome", name);
    await mkdir(destination, { recursive: true });
    await run(["tar", "-xzf", await archiveFor(name), "-C", destination, "--strip-components=1"]);
    const manifest = await Bun.file(join(destination, "package.json")).json();
    if (/"(?:catalog|workspace):/.test(JSON.stringify(manifest))) {
      throw new Error(`${name} tarball retains a workspace-only dependency protocol.`);
    }
    if (["core", "sdk", "providers"].includes(name)) {
      if (manifest.dependencies?.effect !== effectVersion) {
        throw new Error(`${name} tarball does not install exact Effect ${effectVersion}.`);
      }
      if (manifest.peerDependencies?.effect !== undefined) {
        throw new Error(`${name} tarball still declares Effect as a peer dependency.`);
      }
    }
  }
  const effectResolutions = new Set(
    [
      consumerDirectory,
      join(nodeModules, "@mitome", "core"),
      join(nodeModules, "@mitome", "sdk"),
      join(nodeModules, "@mitome", "providers"),
      join(nodeModules, "@effect", "ai-openai"),
      join(nodeModules, "@effect", "ai-openai-compat"),
    ].map((directory) => Bun.resolveSync("effect/package.json", directory)),
  );
  if (effectResolutions.size !== 1) {
    throw new Error(`Packed fixture resolved ${effectResolutions.size} Effect installations.`);
  }
  console.log("Packed fixture resolved one Effect installation.");
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
import * as core from "@mitome/core";
import { createSession, makeProvider } from "@mitome/core";
import { defineAgent, withSession } from "@mitome/sdk";
import * as sdkEffect from "@mitome/sdk/effect";
import { openai } from "@mitome/providers/openai";
import { openaiCompatible } from "@mitome/providers/openai-compatible";
import { codex } from "@mitome/providers/openai-codex";
import { instructions } from "@mitome/sdk/extensions";

if (sdkEffect.createSession !== core.createSession) throw new Error("SDK Effect facade duplicated the Core runtime.");
if (openai().id !== "openai" || codex().id !== "openai-codex") throw new Error("Official Provider packages were not installed.");
if (openaiCompatible({ id: "local", baseUrl: "http://localhost" }).id !== "local") throw new Error("OpenAI-compatible package was not installed.");
// Built through the real published LanguageModel.make constructor; generateText is unused here.
const provider = makeProvider("fixture", [] as const, undefined, () => Layer.effect(LanguageModel.LanguageModel, LanguageModel.make({
  streamText: () => Stream.succeed(Response.makePart("text-delta", { id: "fixture", delta: "ok" })),
  generateText: () => Effect.die("generateText is not used by this smoke"),
})));
const definition = defineAgent({
  providers: [provider] as const,
  model: "fixture/default",
  extensions: [instructions("Release fixture")],
});
await Effect.runPromise(
  Effect.scoped(Effect.as(createSession(definition), undefined)),
);
if (definition.providers[0] !== provider) throw new Error("SDK wrapped the canonical Core Provider.");
if (definition.extensions[0]?.instructions !== "Release fixture") throw new Error("SDK extensions subpath was not installed.");
const events = await withSession(definition, async (session) => {
  const values = [];
  for await (const event of session.runTurn("hello", { model: "fixture/override" })) values.push(event);
  return values;
});
if (events.at(-1)?.type !== "response-complete") throw new Error("Session smoke did not complete.");
`,
  );
  // Typechecking the consumer against the packed declarations is the leak gate:
  // it fails if any published .d.ts references types the tarballs cannot resolve.
  await run([process.execPath, "x", "tsc", "-p", join(consumerDirectory, "tsconfig.json")]);
  await run([process.execPath, "smoke.ts"], consumerDirectory);
  const createdDirectory = join(temporaryDirectory, "created-agent");
  await mkdir(createdDirectory);
  await run(["node", join(nodeModules, ".bin", "create-mitome")], createdDirectory, "1\n1\n2\n");
  const createdPackage = await Bun.file(join(createdDirectory, "package.json")).json();
  if (
    Object.keys(createdPackage.dependencies).join(",") !== "@mitome/providers,@mitome/sdk,effect" ||
    createdPackage.dependencies.effect !== effectVersion
  ) {
    throw new Error("create-mitome generated unexpected Effect dependencies.");
  }
  if (!(await Bun.file(join(createdDirectory, "instructions.md")).exists())) {
    throw new Error("create-mitome did not generate instructions.md.");
  }
  const createdDefinition = await Bun.file(join(createdDirectory, "index.ts")).text();
  if (!createdDefinition.includes("instructionFiles")) {
    throw new Error("create-mitome did not load instructions.md through @mitome/sdk/extensions.");
  }
  if (
    !createdDefinition.includes("providers: [openai()]") ||
    !createdDefinition.includes('model: "openai/')
  ) {
    throw new Error("create-mitome did not generate the Provider-qualified Agent contract.");
  }
  await symlink(nodeModules, join(createdDirectory, "node_modules"), "dir");
  // The fixture vendors Effect without its declaration-only dependencies; the
  // earlier packed-consumer check covers dependency declarations.
  await run([
    process.execPath,
    "x",
    "tsc",
    "-p",
    join(createdDirectory, "tsconfig.json"),
    "--skipLibCheck",
  ]);
  console.log("Release tarball/install fixtures passed.");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
