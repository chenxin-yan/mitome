import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  configDirectory,
  configDirectoryMessage,
  CredentialDescriptorSchema,
  Mitome,
} from "@mitome/core";
import {
  Effect,
  FileSystem,
  Option,
  Path,
  type PlatformError,
  Predicate,
  Schema,
  type Scope,
} from "effect";
import { describe, runtimeError, userError } from "./errors.js";

const Callback = Schema.declare(Predicate.isFunction);

const TextMapping = Schema.Struct({ parse: Callback, render: Callback });

/**
 * The `mitome/1` shape of a `Mitome.make` default export, checked without calling anything and
 * never by brand: the Configuration imports its own copy of `@mitome/core`, not the one in this binary.
 * Functions are recognised only as functions; their requirements cannot be checked here.
 */
const ConfigurationExport = Schema.Struct({
  protocol: Schema.Literal(Mitome.protocol),
  discovery: Schema.Array(
    Schema.Struct({
      id: Schema.NonEmptyString,
      modelIds: Schema.Array(Schema.String),
      models: Schema.Record(Schema.String, Schema.Struct({ contextWindow: Schema.Finite })),
      credential: Schema.UndefinedOr(CredentialDescriptorSchema),
    }),
  ),
  model: Schema.optional(Schema.String),
  // The mapping object itself, not a decoded copy, so its methods keep their receiver.
  text: Schema.declare(Schema.is(TextMapping), {
    expected: "a text mapping with parse and render functions",
  }),
  acquire: Callback,
});

const UnresolvedImport = Schema.Struct({
  code: Schema.Literals(["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"]),
  message: Schema.String,
});

/**
 * The package an import or require could not find, if that was why, and the file that asked for
 * it, in the wordings Node and Bun use. A relative, absolute, URL or `#` specifier is a missing
 * file, not an uninstalled package. Without the importing file nothing is claimed, since whether a
 * package is installed depends on where it is looked for.
 */
const missingPackage = (cause: unknown) => {
  if (!Schema.is(UnresolvedImport)(cause)) return undefined;
  const specifier = /Cannot find (?:package|module) '([^']+)'/.exec(cause.message)?.[1];
  const importer = /(?: imported from |\nRequire stack:\n- )(.+)/.exec(cause.message)?.[1];
  if (
    specifier === undefined ||
    importer === undefined ||
    !isAbsolute(importer) ||
    /^(?:[./\\#]|[a-z][a-z\d+.-]*:)/i.test(specifier)
  )
    return undefined;
  const [scope = specifier, name] = specifier.split("/");
  return { name: specifier.startsWith("@") ? `${scope}/${name}` : scope, importer };
};

/** Whether `name` has a `package.json` where Node would look for it from the file `from`. */
const installed = (name: string, from: string) =>
  (createRequire(from).resolve.paths(name) ?? []).some((directory) =>
    existsSync(join(directory, name, "package.json")),
  );

/** An acquired Configuration as the CLI sees it: its own types are erased by dynamic import. */
export type LoadedInstance = Mitome.Instance<unknown, unknown, unknown, unknown, unknown>;

type Erased<R> = Effect.Effect<unknown, unknown, R>;

/** A validated Configuration module. Every operation it exposes is the producer's own. */
export interface LoadedConfiguration {
  /** As selected, for diagnostics. */
  readonly path: string;
  /** The file `path` resolves to through any symlinks; the module's own imports resolve from it. */
  readonly realPath: string;
  readonly discovery: ReadonlyArray<Mitome.ProviderDiscovery>;
  readonly model: string | undefined;
  readonly acquire: (
    options: Mitome.AcquireOptions,
  ) => Effect.Effect<LoadedInstance, unknown, Scope.Scope>;
  readonly text: {
    /** To be run through `LoadedInstance.provide`, which binds the services it may need. */
    readonly parse: (text: string) => Erased<unknown>;
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the loaded program's result, whose type the CLI never imports
    readonly render: (result: unknown) => Erased<unknown>;
  };
}

/**
 * Calls one exported operation, failing instead of running a non-Effect return. This detects only
 * a broken shape. The trust boundary is here: a `mitome/1` export promises `Mitome.make`'s
 * statically checked closure, so the CLI accepts its stated requirements; a service the module
 * nevertheless leaves unsupplied is a defect of that module, not something this check recovers.
 */
const invoke =
  <R>(what: string, operation: Function) =>
  (...args: ReadonlyArray<unknown>): Erased<R> => {
    const effect: unknown = operation(...args);
    if (!Effect.isEffect(effect)) {
      return Effect.fail(userError(`The Configuration's ${what} did not return an Effect`));
    }
    // SAFETY: the trusted producer contract described above, not an inferred fact.
    return effect as Erased<R>;
  };

const unreadable = (path: string) => (error: PlatformError.PlatformError) =>
  userError(`Could not read ${path}: ${describe(runtimeError(error))}`, runtimeError(error));

const statPath = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.stat(path).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined),
    Effect.mapError(unreadable(path)),
  );
});

/**
 * The file `--config` selects, resolved against the invocation directory: a directory means its
 * `index.ts`. Without the flag, `index.ts` in the config directory. The current directory is never
 * searched, so a repository's code runs only when explicitly selected. The result must be an
 * existing file: importing anything else would let the runtime probe for a similarly named module.
 */
const configurationPath = Effect.fnUntraced(function* (config: Option.Option<string>) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  let path: string;
  if (Option.isSome(config)) {
    const selected = paths.resolve(process.cwd(), config.value);
    path =
      (yield* statPath(selected))?.type === "Directory"
        ? paths.join(selected, "index.ts")
        : selected;
  } else {
    const directory = configDirectory();
    if (directory === undefined) {
      return yield* userError(
        `No config directory for the default Configuration. ${configDirectoryMessage} Or select one with --config <path>.`,
      );
    }
    path = paths.join(directory, "index.ts");
  }
  const stats = yield* statPath(path);
  if (stats === undefined) {
    return yield* userError(
      `No Configuration at ${path}. Create one with npm create mitome, or select another with --config <path>.`,
    );
  }
  if (stats.type !== "File") {
    return yield* userError(
      `${path} is not a file. Select a Configuration file, or a directory holding index.ts, with --config <path>.`,
    );
  }
  const realPath = yield* fs.realPath(path).pipe(Effect.mapError(unreadable(path)));
  return { path, realPath };
});

/**
 * Imports the selected Configuration and validates its default export. Importing runs the
 * module's top-level code; nothing else runs.
 */
export const loadConfiguration = Effect.fnUntraced(function* (config: Option.Option<string>) {
  const { path, realPath } = yield* configurationPath(config);
  const namespace = yield* Effect.tryPromise({
    try: (): Promise<{ readonly default?: unknown }> => import(pathToFileURL(path).href),
    catch: (cause) => {
      const missing = missingPackage(cause);
      // An installed package can still fail to resolve, for example an unexported subpath.
      return missing === undefined || installed(missing.name, missing.importer)
        ? userError(`Could not load ${path}: ${describe(cause)}`, cause)
        : userError(
            `Could not load ${path}: package "${missing.name}" is not installed. Run npm install in ${dirname(realPath)}.`,
            cause,
          );
    },
  });
  if (namespace.default === undefined) {
    return yield* userError(
      `${path} must default-export Mitome.make(...); select another with --config <path>`,
    );
  }
  const loaded = yield* Schema.decodeUnknownEffect(ConfigurationExport)(namespace.default).pipe(
    Effect.mapError((cause) =>
      userError(
        `${path} is not a ${Mitome.protocol} Configuration made by Mitome.make; select another with --config <path>: ${cause.message}`,
        cause,
      ),
    ),
  );
  const ids = loaded.discovery.map(({ id }) => id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate !== undefined) {
    return yield* userError(`${path} declares Provider "${duplicate}" more than once`);
  }
  const acquire = invoke<Scope.Scope>("acquire", loaded.acquire);
  const configuration: LoadedConfiguration = {
    path,
    realPath,
    discovery: loaded.discovery,
    model: loaded.model,
    // SAFETY: `acquire` succeeds with the producer's own Instance by the same contract.
    acquire: (options) => acquire(options) as ReturnType<LoadedConfiguration["acquire"]>,
    text: {
      parse: invoke("text.parse", (text: string) => loaded.text.parse(text)),
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the loaded program's result, whose type the CLI never imports
      render: invoke("text.render", (result: unknown) => loaded.text.render(result)),
    },
  };
  return configuration;
});
