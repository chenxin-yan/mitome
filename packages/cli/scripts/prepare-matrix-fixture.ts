import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const packageDirectory = resolve(import.meta.dir, "..");
const coreDirectory = resolve(packageDirectory, "../core");
const rootDirectory = resolve(packageDirectory, "..", "..");
const outputDirectory = process.argv[2];

if (outputDirectory === undefined) {
  throw new Error("Usage: bun scripts/prepare-matrix-fixture.ts <directory>");
}

const installedPackage = (name: string): string => {
  const store = join(rootDirectory, "node_modules", ".bun");
  const entry = [
    ...new Bun.Glob(`**/node_modules/${name}/package.json`).scanSync({ cwd: store }),
  ][0];
  if (entry === undefined) throw new Error(`Cannot find installed ${name}`);
  return dirname(join(store, entry));
};

const copyPackage = async (
  name: string,
  nodeModules: string,
  copied = new Set<string>(),
): Promise<void> => {
  if (copied.has(name)) return;
  copied.add(name);
  const source = installedPackage(name);
  const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    await copyPackage(dependency, nodeModules, copied);
  }
  const destination = join(nodeModules, name);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, dereference: true });
};

await rm(outputDirectory, { recursive: true, force: true });
const definition = join(outputDirectory, "definition", "agent.ts");
const nodeModules = join(dirname(definition), "node_modules");
const core = join(nodeModules, "@mitome", "core");
await mkdir(core, { recursive: true });
await writeFile(
  definition,
  `import { Layer, Stream } from "effect";
import { LanguageModel, Response } from "effect/unstable/ai";
import { makeModel } from "@mitome/core";

interface MatrixFixture { readonly text: string }
const fixture: MatrixFixture = { text: "matrix" };
const model = makeModel(Layer.succeed(LanguageModel.LanguageModel, {
  streamText: () => Stream.succeed(Response.makePart("text-delta", { id: "matrix", delta: fixture.text })),
}));
export default { instructions: "Reply with the fixture output.", model, plugins: [] };
`,
);
await cp(join(coreDirectory, "dist"), join(core, "dist"), { recursive: true });
await cp(join(coreDirectory, "package.json"), join(core, "package.json"));
await copyPackage("effect", nodeModules);
await Promise.all([
  mkdir(join(outputDirectory, "empty-path")),
  mkdir(join(outputDirectory, "home")),
  mkdir(join(outputDirectory, "xdg")),
]);
console.log(`Prepared matrix fixture in ${resolve(outputDirectory)}.`);
