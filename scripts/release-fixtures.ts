import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { catalogVersions, knownModelIds } from "../packages/create-mitome/src/model-hints.ts";
import { checkArchives, type ReleasePackage, releasePackages } from "./release.ts";

const rootDirectory = resolve(import.meta.dir, "..");
const packages = releasePackages();
const publicPackages = packages.filter((pkg) => !pkg.name.startsWith("@mitome/cli-"));
const cli = packages.find((pkg) => pkg.name === "@mitome/cli")!;
const temporaryDirectory = await mkdtemp(join(tmpdir(), "mitome-release-fixtures-"));
const suppliedArchives = process.env.MITOME_RELEASE_ARTIFACTS;
const archivesDirectory = suppliedArchives
  ? resolve(suppliedArchives)
  : join(temporaryDirectory, "archives");
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

const archiveFor = (pkg: ReleasePackage): string => join(archivesDirectory, pkg.archive);

try {
  if (suppliedArchives) {
    checkArchives(packages, archivesDirectory);
  } else {
    for (const pkg of publicPackages) {
      // The root LICENSE is the single source; tarballs need a per-package copy.
      await cp(join(rootDirectory, "LICENSE"), join(pkg.directory, "LICENSE"));
      await run(
        ["pnpm", "pack", "--pack-destination", archivesDirectory, "--ignore-scripts"],
        pkg.directory,
      );
    }
  }
  for (const pkg of publicPackages) {
    const archive = archiveFor(pkg);
    await run(["pnpm", "exec", "publint", "--strict", archive]);
    if (pkg !== cli) {
      await run([
        "pnpm",
        "exec",
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

  const workspace = await Bun.file(join(rootDirectory, "pnpm-workspace.yaml")).text();
  // SAFETY: the repository's own workspace file, whose catalog pins Effect.
  const { catalog } = Bun.YAML.parse(workspace) as { catalog: { effect: string } };
  const effectVersion = catalog.effect;
  const nodeTypesVersion = catalogVersions["@types/node"];
  const installedEffectManifest = Bun.resolveSync("effect/package.json", rootDirectory);
  const installedEffectVersion: string = (await Bun.file(installedEffectManifest).json()).version;
  if (installedEffectVersion !== effectVersion) {
    throw new Error(`Installed Effect ${installedEffectVersion} is not catalog ${effectVersion}.`);
  }
  const dependencies = Object.fromEntries(
    publicPackages.map((pkg) => [pkg.name, `file:${archiveFor(pkg)}`]),
  );
  const effectArchive = `file:../vendor/effect-${effectVersion}.tgz`;
  const nodeModules = join(consumerDirectory, "node_modules");
  await mkdir(consumerDirectory, { recursive: true });
  await Bun.write(
    join(consumerDirectory, "package.json"),
    JSON.stringify({
      name: "release-fixture",
      private: true,
      // The generated application type-checks against Node's types, as its own install would.
      dependencies: { ...dependencies, effect: effectArchive, "@types/node": nodeTypesVersion },
      overrides: { ...dependencies, effect: effectArchive },
    }),
  );
  const effectDirectory = join(temporaryDirectory, "vendor", "effect");
  await cp(dirname(installedEffectManifest), effectDirectory, {
    recursive: true,
    dereference: true,
  });
  // Silent: Effect's file listing runs to thousands of lines; a failure is still reported.
  await run(
    [
      "pnpm",
      "--silent",
      "pack",
      "--pack-destination",
      dirname(effectDirectory),
      "--ignore-scripts",
    ],
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
  for (const pkg of publicPackages) {
    const manifest = await Bun.file(join(nodeModules, pkg.name, "package.json")).json();
    if (/"(?:catalog|workspace):/.test(JSON.stringify(manifest))) {
      throw new Error(`${pkg.name} tarball retains a workspace-only dependency protocol.`);
    }
    if (["@mitome/core", "@mitome/providers"].includes(pkg.name)) {
      if (manifest.dependencies?.effect !== effectVersion) {
        throw new Error(`${pkg.name} tarball does not install exact Effect ${effectVersion}.`);
      }
      if (manifest.peerDependencies?.effect !== undefined) {
        throw new Error(`${pkg.name} tarball still declares Effect as a peer dependency.`);
      }
    }
  }
  const effectResolutions = new Set(
    [
      consumerDirectory,
      join(nodeModules, "@mitome", "core"),
      join(nodeModules, "@mitome", "providers"),
      join(nodeModules, "@effect", "ai-anthropic"),
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
import { LanguageModel, Prompt } from "effect/ai";
import {
  Provider,
  Turn,
  withModelRequestAccounting,
} from "@mitome/core";
import { loop, Session } from "@mitome/core/kernel";
import { anthropic } from "@mitome/providers/anthropic";
import { openai } from "@mitome/providers/openai";
import { openaiCompatible } from "@mitome/providers/openai-compatible";
import { codex } from "@mitome/providers/openai-codex";

if (openai().id !== "openai" || codex().id !== "openai-codex" || anthropic().id !== "anthropic") throw new Error("Official Provider packages were not installed.");
if (openaiCompatible({ id: "local", baseUrl: "http://localhost" }).id !== "local") throw new Error("OpenAI-compatible package was not installed.");
// Built through the real published LanguageModel.make constructor; streamText is unused here.
const provider = Provider.make("fixture", { modelIds: [] as const, provision: () => withModelRequestAccounting("fixture", Layer.effect(LanguageModel.LanguageModel, LanguageModel.make({
  generateText: () => Effect.succeed([{ type: "text", text: "ok" }]),
  streamText: () => Stream.die(new Error("streamText is not used by this smoke")),
}))) });
const text = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* Session.make({ transcript: "none" });
      const text = yield* session.run(
        Effect.gen(function* () {
          const turn = yield* Turn;
          yield* turn.stage(Prompt.userMessage({ content: [Prompt.textPart({ text: "hello" })] }));
          return (yield* loop()).response.text;
        }),
      );
      if ((yield* session.history).length !== 2) throw new Error("Turn did not commit its conversation.");
      return text;
    }),
  ).pipe(Effect.provide(Provider.model(provider, "default"))),
);
if (text !== "ok") throw new Error("Session smoke did not complete.");
`,
  );
  // Typechecking the consumer against the packed declarations is the leak gate:
  // it fails if any published .d.ts references types the tarballs cannot resolve.
  await run(["pnpm", "exec", "tsc", "-p", join(consumerDirectory, "tsconfig.json")]);
  await run([process.execPath, "smoke.ts"], consumerDirectory);
  const createdDirectory = join(temporaryDirectory, "created-app");
  await mkdir(createdDirectory);
  await run(["node", join(nodeModules, ".bin", "create-mitome")], createdDirectory, "1\n1\n");
  const createdPackage = await Bun.file(join(createdDirectory, "package.json")).json();
  if (
    Object.keys(createdPackage.dependencies).join(",") !==
      "@mitome/core,@mitome/providers,effect" ||
    createdPackage.dependencies.effect !== effectVersion ||
    createdPackage.devDependencies.typescript !== catalogVersions.typescript ||
    createdPackage.devDependencies["@types/node"] !== nodeTypesVersion
  ) {
    throw new Error("create-mitome generated unexpected dependency versions.");
  }
  const createdAgent = await Bun.file(join(createdDirectory, "src", "agent.ts")).text();
  const createdMain = await Bun.file(join(createdDirectory, "src", "main.ts")).text();
  if (
    !createdAgent.includes("export const agent = Agent.make({") ||
    !createdMain.includes('import { agent } from "./agent.ts";') ||
    !createdMain.includes("Session.make(agent)")
  ) {
    throw new Error("create-mitome did not generate the Agent and the application that embeds it.");
  }
  // The input chose OpenAI and its first hinted Model.
  if (
    !createdMain.includes(`Provider.model(openai(), ${JSON.stringify(knownModelIds.openai[0])})`)
  ) {
    throw new Error("create-mitome did not select the chosen OpenAI Model.");
  }
  await symlink(nodeModules, join(createdDirectory, "node_modules"), "dir");
  await run(["pnpm", "exec", "tsc", "-p", join(createdDirectory, "tsconfig.json")]);
  if (suppliedArchives) {
    const cliConsumer = join(temporaryDirectory, "cli-consumer");
    await mkdir(cliConsumer);
    const platforms = Object.fromEntries(
      packages.flatMap((pkg) =>
        pkg.name.startsWith("@mitome/cli-")
          ? [[pkg.name, `file:${join(archivesDirectory, pkg.archive)}`]]
          : [],
      ),
    );
    await writeFile(
      join(cliConsumer, "package.json"),
      JSON.stringify({
        name: "cli-release-fixture",
        private: true,
        dependencies: { "@mitome/cli": `file:${archiveFor(cli)}` },
        overrides: platforms,
      }),
    );
    await run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"], cliConsumer);
    const child = Bun.spawn(["node", join(cliConsumer, "node_modules/.bin/mitome"), "--version"], {
      cwd: cliConsumer,
      stdout: "pipe",
      stderr: "inherit",
    });
    const output = await new Response(child.stdout).text();
    if ((await child.exited) !== 0 || output.trim() !== `mitome v${cli.version}`) {
      throw new Error(`Installed CLI binary failed: ${output}`);
    }
  }
  console.log("Release tarball/install fixtures passed.");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
