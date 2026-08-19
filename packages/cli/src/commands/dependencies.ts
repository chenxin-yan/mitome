import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Console, Effect, Option } from "effect";
import { ChildHost } from "../child-host.js";
import { definitionPath } from "../definition.js";
import { attempt, type ExitCode } from "../support.js";

type Manifest = Record<string, unknown> & { readonly dependencies?: Record<string, string> };

const packageSpec = (input: string): { readonly name: string; readonly version: string } => {
  const versionSeparator = input.startsWith("@")
    ? input.indexOf("@", input.indexOf("/") + 1)
    : input.indexOf("@");
  const name = versionSeparator === -1 ? input : input.slice(0, versionSeparator);
  const version = versionSeparator === -1 ? "latest" : input.slice(versionSeparator + 1);
  if (name.length === 0 || (name.startsWith("@") && !name.includes("/")) || version.length === 0) {
    throw new Error(`Invalid package specifier: ${input}`);
  }
  return { name, version };
};

const manifestAt = async (path: string): Promise<{ path: string; manifest: Manifest }> => {
  const manifestPath = join(dirname(path), "package.json");
  const value: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${manifestPath} must contain a JSON object.`);
  }
  // Deeper shape validation is bun install's job; it rejects a malformed manifest itself.
  return { path: manifestPath, manifest: value as Manifest };
};

const writeDependencies = async (
  definition: string,
  edit: (dependencies: Record<string, string>) => void,
): Promise<void> => {
  const { path, manifest } = await manifestAt(definition);
  const dependencies = { ...manifest.dependencies };
  edit(dependencies);
  await writeFile(path, `${JSON.stringify({ ...manifest, dependencies }, null, 2)}\n`);
};

const factoryName = (packageName: string): string => {
  const lastSegment = packageName.slice(packageName.lastIndexOf("/") + 1);
  return lastSegment
    .replace(/^mitome-ext-/, "")
    .replace(/^mitome-/, "")
    .replace(/[-_.]+([a-zA-Z0-9])/g, (_, character: string) => character.toUpperCase());
};

const usageSnippet = (packageName: string, exportNames: ReadonlyArray<string>): string => {
  const derived = factoryName(packageName);
  const candidates = exportNames
    .filter((name) => name !== "default" && /^[a-zA-Z_$][\w$]*$/.test(name))
    .sort();
  const selected =
    candidates.length === 1 ? candidates[0] : candidates.find((name) => name === derived);
  if (selected !== undefined) {
    return `import { ${selected} } from "${packageName}";\nextensions: [${selected}()],`;
  }
  return `import { ${derived} } from "${packageName}"; // verify export name\nextensions: [${derived}()],`;
};

export const runAdd = Effect.fn("@mitome/cli/runAdd")(function* ({
  package: input,
  use,
}: {
  readonly package: string;
  readonly use: Option.Option<string>;
}) {
  const childHost = yield* ChildHost;
  const definition = yield* attempt(() => definitionPath(use));
  const spec = yield* attempt(async () => packageSpec(input));
  let previousVersion: string | undefined;
  yield* attempt(() =>
    writeDependencies(definition, (dependencies) => {
      previousVersion = dependencies[spec.name];
      dependencies[spec.name] = spec.version;
    }),
  );
  const exitCode = yield* childHost.install(definition);
  if (exitCode !== 0) {
    // Restore the manifest so a failed install does not persist the new dependency.
    yield* attempt(() =>
      writeDependencies(definition, (dependencies) => {
        if (previousVersion === undefined) delete dependencies[spec.name];
        else dependencies[spec.name] = previousVersion;
      }),
    );
    return exitCode;
  }
  // Inspection failures still leave the manual manifest path usable; the user can verify the export name.
  const exportNames = yield* childHost
    .listExports(spec.name, dirname(definition))
    .pipe(Effect.orElseSucceed(() => []));
  yield* Console.log(usageSnippet(spec.name, exportNames));
  return 0 satisfies ExitCode;
});

export const runRemove = Effect.fn("@mitome/cli/runRemove")(function* ({
  package: packageName,
  use,
}: {
  readonly package: string;
  readonly use: Option.Option<string>;
}) {
  const childHost = yield* ChildHost;
  const definition = yield* attempt(() => definitionPath(use));
  const removeExitCode = yield* childHost.removeDependency(definition, packageName);
  if (removeExitCode !== 0) return removeExitCode;
  return yield* childHost.install(definition);
});
