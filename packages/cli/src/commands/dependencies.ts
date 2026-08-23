import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Console, Effect, Option, Result, Schema } from "effect";
import { ChildHost } from "../child-host-service.js";
import { definitionPath } from "../definition.js";
import { attempt, type ExitCode } from "../support.js";

interface Manifest extends Schema.JsonObject {
  readonly dependencies?: Readonly<Record<string, string>>;
}

const JsonObject = Schema.Record(Schema.String, Schema.Json);
const Dependencies = Schema.Record(Schema.String, Schema.String);

// npm package-name grammar; rejects path-like names such as ".." that would otherwise
// escape node_modules when the failed-install rollback removes the package directory.
const packageNamePattern = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

const packageSpec = (input: string) => {
  const versionSeparator = input.startsWith("@")
    ? input.indexOf("@", input.indexOf("/") + 1)
    : input.indexOf("@");
  const name = versionSeparator === -1 ? input : input.slice(0, versionSeparator);
  const version = versionSeparator === -1 ? "latest" : input.slice(versionSeparator + 1);
  if (!packageNamePattern.test(name) || version.length === 0) {
    throw new Error(`Invalid package specifier: ${input}`);
  }
  return { name, version };
};

const manifestAt = async (path: string): Promise<{ path: string; manifest: Manifest }> => {
  const manifestPath = join(dirname(path), "package.json");
  const value = Schema.decodeUnknownResult(JsonObject)(
    JSON.parse(await readFile(manifestPath, "utf8")),
  );
  if (Result.isFailure(value)) throw new Error(`${manifestPath} must contain a JSON object.`);
  // writeDependencies spreads this field before bun can validate it, which would silently
  // transform a malformed value (array, string) and break the failed-install rollback.
  const dependencies = Schema.decodeUnknownResult(Schema.UndefinedOr(Dependencies))(
    value.success.dependencies,
  );
  if (Result.isFailure(dependencies)) {
    throw new Error(`${manifestPath} dependencies must be an object of package versions.`);
  }
  const manifest: Manifest =
    dependencies.success === undefined
      ? value.success
      : { ...value.success, dependencies: dependencies.success };
  return { path: manifestPath, manifest };
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
    // A lone export that does not match the derived name may be a helper, not the factory.
    const hedge = selected === derived ? "" : " // verify export name";
    return `import { ${selected} } from "${packageName}";${hedge}\nextensions: [${selected}()],`;
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
    // Bun may have extracted the package and saved the lockfile before a lifecycle script
    // failed; bun does not prune extraneous node_modules entries, so remove a new one here
    // and reconcile the lockfile with a best-effort install of the restored manifest.
    if (previousVersion === undefined) {
      yield* attempt(() =>
        rm(join(dirname(definition), "node_modules", spec.name), { recursive: true, force: true }),
      );
    }
    yield* childHost.install(definition).pipe(Effect.ignore);
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
  // bun remove already uninstalls the package and reconciles the lockfile and node_modules;
  // a follow-up install would only re-run lifecycle scripts a second time.
  return yield* childHost.removeDependency(definition, packageName);
});
