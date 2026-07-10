import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { packageVersion, publicPackages } from "./check-lockstep.ts";

const rootDirectory = resolve(import.meta.dir, "..");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "mitome-release-fixtures-"));
const archivesDirectory = join(temporaryDirectory, "archives");
const consumerDirectory = join(temporaryDirectory, "consumer");
const forbidden = [
  /from ["']effect(?:[/'"]|$)/,
  /["']effect["']/,
  /effect\//,
  /Effect</,
  /Layer</,
  /Scope/,
  /Stream</,
  /Context\.Tag/,
  /HttpClient/,
  /FetchHttpClient/,
  /Redacted/,
  /Secret/,
];

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
    await run(
      [process.execPath, "pm", "pack", "--destination", archivesDirectory, "--ignore-scripts"],
      join(rootDirectory, "packages", name),
    );
  }

  for (const name of publicPackages) {
    const archive = await archiveFor(name);
    const listed = Bun.spawnSync(["tar", "-tzf", archive], { stdout: "pipe" });
    if (listed.exitCode !== 0) throw new Error(`Cannot inspect ${archive}.`);
    const listing = new TextDecoder().decode(listed.stdout);
    for (const file of listing.trim().split("\n")) {
      const allowed =
        file === "package/package.json" ||
        file === "package/LICENSE" ||
        file === "package/NOTICE" ||
        file === "package/README.md" ||
        /^package\/dist\/[^/]+\.(?:js|d\.ts)$/.test(file) ||
        file === "package/scripts/mitome.mjs" ||
        file === "package/scripts/postinstall.mjs";
      if (!allowed) throw new Error(`${name} tarball exposes ${file}.`);
    }
    if (name !== "cli" && !listing.includes("package/dist/index.js")) {
      throw new Error(`${name} tarball must include dist/index.js.`);
    }
    if (name === "cli" && listing.includes("package/dist/")) {
      throw new Error("CLI tarball must not bundle a platform binary.");
    }
    if (name === "openai-codex" && !listing.includes("package/NOTICE")) {
      throw new Error("OpenAI Codex tarball must include its Pi attribution NOTICE.");
    }

    const extraction = join(temporaryDirectory, "extract", name);
    await mkdir(extraction, { recursive: true });
    await run(["tar", "-xzf", archive, "-C", extraction], rootDirectory);
    if (name !== "core") {
      for (const file of new Bun.Glob("package/dist/**/*.d.ts").scanSync({ cwd: extraction })) {
        const declaration = await readFile(join(extraction, file), "utf8");
        // SDK deliberately exposes EffectSchema = Schema.Codec and the typed-hook
        // Prompt alias; only these exact imports are exempt, all other Effect
        // patterns stay forbidden.
        const sdkExemptImports = [
          'import { Schema } from "effect";\n',
          'import { Prompt as AiPrompt } from "effect/unstable/ai";\n',
        ];
        const publicDeclaration =
          name === "sdk"
            ? sdkExemptImports.reduce((text, line) => text.replace(line, ""), declaration)
            : declaration;
        const match = forbidden.find((pattern) => pattern.test(publicDeclaration));
        if (match !== undefined) throw new Error(`${name} tarball declaration leaks ${match}.`);
      }
    }
  }

  const storeDirectory = join(rootDirectory, "node_modules", ".bun");
  const installedPackage = (name: string): string => {
    const entry = [
      ...new Bun.Glob(`**/node_modules/${name}/package.json`).scanSync({ cwd: storeDirectory }),
    ][0];
    if (entry === undefined) throw new Error(`Cannot find installed ${name}.`);
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
  await cp(installedPackage("effect"), join(temporaryDirectory, "vendor", "effect"), {
    recursive: true,
    dereference: true,
  });
  await run([process.execPath, "install"], consumerDirectory);
  if (!(await Bun.file(join(nodeModules, ".bin", "mitome")).exists())) {
    throw new Error("Bun install did not link the CLI launcher.");
  }
  for (const name of publicPackages) {
    const destination = join(nodeModules, "@mitome", name);
    await mkdir(destination, { recursive: true });
    await run(["tar", "-xzf", await archiveFor(name), "-C", destination, "--strip-components=1"]);
  }
  await writeFile(
    join(consumerDirectory, "smoke.mjs"),
    `import { Effect, Layer, Stream } from "effect";
import { LanguageModel, Response } from "effect/unstable/ai";
import { createSession, makeModel } from "@mitome/core";
import { defineAgent, withSession } from "@mitome/sdk";
import { env, openai } from "@mitome/openai";
import { openaiCompatible } from "@mitome/openai-compatible";
import { codex, oauth } from "@mitome/openai-codex";

process.env.OPENAI_API_KEY = "fixture";
const provider = openai("fixture", env("OPENAI_API_KEY"));
if (typeof openaiCompatible !== "function") throw new Error("OpenAI-compatible package was not installed.");
await Effect.runPromise(Effect.scoped(Effect.as(createSession(defineAgent({ instructions: "", model: provider, plugins: [] })), undefined)));
if (typeof codex !== "function" || typeof oauth().capability.module !== "string") throw new Error("Codex package was not installed.");
const model = makeModel(Layer.succeed(LanguageModel.LanguageModel, {
  streamText: () => Stream.succeed(Response.makePart("text-delta", { id: "fixture", delta: "ok" })),
}));
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
  await run([process.execPath, "smoke.mjs"], consumerDirectory);
  console.log("Release tarball/install fixtures passed.");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
