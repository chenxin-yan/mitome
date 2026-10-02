import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type AcquireOptions,
  type Application,
  CredentialDescriptorSchema,
  mitomeProtocol,
  type ProviderDiscovery,
} from "@mitome/core";
import { Effect, Predicate, Schema, type Scope } from "effect";
import { CliError } from "effect/cli";

/** Why something failed, for a one-line diagnostic. */
export const describe = (cause: typeof Schema.Unknown.Type): string =>
  cause instanceof Error ? cause.message : String(cause);

export const userError = (userMessage: string, cause?: typeof Schema.Unknown.Type) =>
  new CliError.UserError({ cause, userMessage });

const Callback = Schema.declare(Predicate.isFunction);

/**
 * The `mitome/1` shape of a `defineMitome` default export, checked without calling anything.
 * Functions are recognised only as functions; their requirements cannot be checked here.
 */
const ApplicationExport = Schema.Struct({
  protocol: Schema.Literal(mitomeProtocol),
  discovery: Schema.Array(
    Schema.Struct({
      id: Schema.NonEmptyString,
      modelIds: Schema.Array(Schema.String),
      models: Schema.Record(Schema.String, Schema.Struct({ contextWindow: Schema.Finite })),
      credential: Schema.UndefinedOr(CredentialDescriptorSchema),
    }),
  ),
  defaultModel: Schema.optionalKey(Schema.String),
  fallbackModels: Schema.optionalKey(Schema.Array(Schema.String)),
  configDirectory: Schema.optional(Schema.String),
  cli: Schema.optionalKey(Schema.Struct({ parseInput: Callback, renderResult: Callback })),
  acquire: Callback,
});

/** An acquired application as the CLI sees it: its own types are erased by dynamic import. */
export type LoadedRuntime = Application<
  typeof Schema.Unknown.Type,
  typeof Schema.Unknown.Type,
  typeof Schema.Unknown.Type,
  typeof Schema.Unknown.Type
>;

type Erased<R> = Effect.Effect<typeof Schema.Unknown.Type, typeof Schema.Unknown.Type, R>;

/** A validated application module. Every operation it exposes is the producer's own. */
export interface LoadedApplication {
  readonly path: string;
  readonly discovery: ReadonlyArray<ProviderDiscovery>;
  readonly defaultModel: string | undefined;
  readonly fallbackModels: ReadonlyArray<string>;
  readonly configDirectory: string | undefined;
  readonly acquire: (
    options: AcquireOptions,
  ) => Effect.Effect<LoadedRuntime, typeof Schema.Unknown.Type, Scope.Scope>;
  readonly cli:
    | {
        /** To be run through `LoadedRuntime.provide`, which binds the services it may need. */
        readonly parseInput: (text: string) => Erased<typeof Schema.Unknown.Type>;
        readonly renderResult: (
          result: typeof Schema.Unknown.Type,
        ) => Erased<typeof Schema.Unknown.Type>;
      }
    | undefined;
}

/**
 * Calls one exported operation, failing instead of running a non-Effect return. This detects only
 * a broken shape. The trust boundary is here: a `mitome/1` export promises `defineMitome`'s
 * statically checked closure, so the CLI accepts its stated requirements; a service the module
 * nevertheless leaves unsupplied is a defect of that module, not something this check recovers.
 */
const invoke =
  <R>(what: string, operation: Function) =>
  (...args: ReadonlyArray<typeof Schema.Unknown.Type>): Erased<R> => {
    const effect: typeof Schema.Unknown.Type = operation(...args);
    if (!Effect.isEffect(effect)) {
      return Effect.fail(userError(`The application's ${what} did not return an Effect`));
    }
    // SAFETY: the trusted producer contract described above, not an inferred fact.
    return effect as Erased<R>;
  };

/**
 * Imports one explicitly selected module, resolved against the invocation directory, and
 * validates its default export. Importing runs the module's top-level code; nothing else runs.
 */
export const loadApplication = (file: string) =>
  Effect.gen(function* () {
    const path = resolve(process.cwd(), file);
    const namespace = yield* Effect.tryPromise({
      try: (): Promise<{ readonly default?: typeof Schema.Unknown.Type }> =>
        import(pathToFileURL(path).href),
      catch: (cause) => userError(`Could not load ${path}: ${describe(cause)}`, cause),
    });
    if (namespace.default === undefined) {
      return yield* userError(`${path} must default-export defineMitome(...)`);
    }
    const loaded = yield* Schema.decodeUnknownEffect(ApplicationExport)(namespace.default).pipe(
      Effect.mapError((cause) =>
        userError(`${path} is not a ${mitomeProtocol} application: ${cause.message}`, cause),
      ),
    );
    const ids = loaded.discovery.map(({ id }) => id);
    const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
    if (duplicate !== undefined) {
      return yield* userError(`${path} declares Provider "${duplicate}" more than once`);
    }
    const acquire = invoke<Scope.Scope>("acquire", loaded.acquire);
    const cli = loaded.cli;
    const application: LoadedApplication = {
      path,
      discovery: loaded.discovery,
      defaultModel: loaded.defaultModel,
      fallbackModels: loaded.fallbackModels ?? [],
      configDirectory: loaded.configDirectory,
      // SAFETY: `acquire` succeeds with the producer's own Application by the same contract.
      acquire: (options) =>
        acquire(options) as Effect.Effect<LoadedRuntime, typeof Schema.Unknown.Type, Scope.Scope>,
      cli:
        cli === undefined
          ? undefined
          : {
              parseInput: invoke("parseInput", cli.parseInput),
              renderResult: invoke("renderResult", cli.renderResult),
            },
    };
    return application;
  });
