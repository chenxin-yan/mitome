import { createInterface, type Interface } from "node:readline";
import {
  type AuthCapability,
  configDirectory,
  configDirectoryMessage,
  type ProviderDiscovery,
} from "@mitome/core";
import { Console, Effect, Option, Predicate, Schema, Stdio, Stream } from "effect";
import { CliError } from "effect/cli";
import { describe, loadApplication, type LoadedApplication, userError } from "./application.js";

/** The largest delay a platform timer accepts. */
const maxGrace = 2_147_483_647;

/** Parses a positive `--grace` duration written as `<n>ms` or `<n>s`, in milliseconds. */
export const parseGrace = (value: string): number => {
  const match = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(value);
  const milliseconds =
    match === null ? Number.NaN : Number(match[1]) * (match[2] === "s" ? 1000 : 1);
  if (!(milliseconds > 0 && milliseconds <= maxGrace)) {
    throw new RangeError(
      `Invalid grace "${value}": expected a positive duration such as 500ms or 5s, at most ${maxGrace}ms`,
    );
  }
  return milliseconds;
};

/**
 * Best-effort bound on cooperative shutdown, owned by the standalone CLI. A first SIGINT or
 * SIGTERM starts a wall-clock timer before the runtime begins interrupting; if cleanup is still
 * running when it fires, the process exits nonzero without claiming cleanup finished. Normal
 * completion removes the listeners and the timer. A blocked event loop needs an external
 * supervisor.
 */
const graceDeadline = (grace: number) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onSignal = () => {
        timer ??= setTimeout(() => {
          process.stderr.write(
            `mitome: shutdown did not finish within its ${grace}ms grace; exiting before cleanup completed\n`,
          );
          process.exit(1);
        }, grace);
      };
      process.prependListener("SIGINT", onSignal);
      process.prependListener("SIGTERM", onSignal);
      return { onSignal, clear: () => clearTimeout(timer) };
    }),
    ({ onSignal, clear }) =>
      Effect.sync(() => {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        clear();
      }),
  );

/** One positional argument wins; otherwise all of non-terminal stdin is one input. */
const readInput = (input: Option.Option<string>) =>
  Effect.gen(function* () {
    if (Option.isSome(input)) return input.value;
    const stdio = yield* Stdio.Stdio;
    if (yield* stdio.stdinIsTerminal) {
      return yield* userError("Provide input as an argument or on standard input.");
    }
    return yield* stdio.stdin.pipe(
      Stream.decodeText(),
      Stream.mkString,
      Effect.mapError((cause) => userError(`Could not read standard input: ${describe(cause)}`)),
    );
  });

/** Writes the rendered result exactly, ending it with one newline unless it is empty or has one. */
const writeResult = (text: string) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    const output = text === "" || text.endsWith("\n") ? text : `${text}\n`;
    yield* Stream.make(output).pipe(
      Stream.run(stdio.stdout()),
      Effect.mapError((cause) => userError(`Could not write the result: ${describe(cause)}`)),
    );
  });

const failingWith = (prefix: string) =>
  Effect.mapError((cause: typeof Schema.Unknown.Type) =>
    cause instanceof CliError.UserError ? cause : userError(`${prefix}${describe(cause)}`, cause),
  );

export interface RunOptions {
  readonly app: string;
  readonly provider: Option.Option<string>;
  readonly model: Option.Option<string>;
  readonly grace: number;
  readonly input: Option.Option<string>;
}

/**
 * One-shot execution: load, read input, acquire, allocate one fresh Session, parse, run one Turn,
 * render, then close the Session and shut down. A render failure after the Turn committed is
 * reported and never reruns the Turn.
 */
export const runApplication = (options: RunOptions) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* graceDeadline(options.grace);
      const app = yield* loadApplication(options.app);
      const cli = app.cli;
      if (cli === undefined) {
        return yield* userError(
          `${app.path} declares no cli mapping (parseInput and renderResult), which mitome run needs`,
        );
      }
      const text = yield* readInput(options.input);
      const application = yield* app
        .acquire({
          provider: Option.getOrUndefined(options.provider),
          model: Option.getOrUndefined(options.model),
        })
        .pipe(failingWith("Could not start the application: "));
      const session = yield* application.session.pipe(failingWith(""));
      const input = yield* application
        .provide(cli.parseInput(text))
        .pipe(failingWith("Could not parse the input: "));
      const result = yield* session.run(input).pipe(failingWith("The application failed: "));
      const rendered = yield* application
        .provide(cli.renderResult(result))
        .pipe(failingWith("The Turn committed, but its result could not be rendered: "));
      if (!Predicate.isString(rendered)) {
        return yield* userError(
          "The Turn committed, but renderResult did not produce a string; it is not rerun",
        );
      }
      yield* writeResult(rendered);
      yield* session.close;
    }),
  );

const modelHint = (provider: ProviderDiscovery, modelId: string) => {
  const window = provider.models[modelId]?.contextWindow;
  return `  ${provider.id}/${modelId}${window === undefined ? "" : ` (context window ${window})`}`;
};

/** Lists declared Providers and their catalog hints; nothing is acquired or authenticated. */
export const listProviders = (file: string) =>
  Effect.gen(function* () {
    const app = yield* loadApplication(file);
    if (app.discovery.length === 0) return yield* Console.log("No Providers declared.");
    const lines = app.discovery.flatMap((provider) => [
      provider.id,
      ...[...new Set([...provider.modelIds, ...Object.keys(provider.models)])].map((modelId) =>
        modelHint(provider, modelId),
      ),
    ]);
    if (app.defaultModel !== undefined) lines.push(`default: ${app.defaultModel}`);
    if (app.fallbackModels.length > 0) lines.push(`fallbacks: ${app.fallbackModels.join(", ")}`);
    lines.push("Catalogs are hints; any Provider-native Model id can be selected.");
    yield* Console.log(lines.join("\n"));
  });

const findProvider = (app: LoadedApplication, id: string) => {
  const provider = app.discovery.find((candidate) => candidate.id === id);
  return provider === undefined
    ? Effect.fail(
        userError(
          `Unknown Provider "${id}"; declared: ${app.discovery.map((p) => p.id).join(", ") || "none"}`,
        ),
      )
    : Effect.succeed(provider);
};

/** Offline credential facts: environment presence, or that an Auth capability exists. */
const credentialStatus = (provider: ProviderDiscovery): string => {
  const credential = provider.credential;
  if (credential === undefined) return `${provider.id}: needs no credential`;
  if (Predicate.isString(credential)) {
    return `${provider.id}: ${credential} ${process.env[credential] ? "present" : "missing"}`;
  }
  return `${provider.id}: auth capability available; credential status unknown`;
};

export const authStatus = (file: string, providerId: Option.Option<string>) =>
  Effect.gen(function* () {
    const app = yield* loadApplication(file);
    const providers = Option.isSome(providerId)
      ? [yield* findProvider(app, providerId.value)]
      : app.discovery;
    yield* Console.log(
      providers.length === 0
        ? "No Providers declared."
        : providers.map(credentialStatus).join("\n"),
    );
  });

/** The Provider to authenticate: the one named, or the only one declaring a credential. */
const selectCredentialed = (app: LoadedApplication, providerId: Option.Option<string>) => {
  if (Option.isSome(providerId)) return findProvider(app, providerId.value);
  const credentialed = app.discovery.filter((provider) => provider.credential !== undefined);
  const [only] = credentialed;
  if (only !== undefined && credentialed.length === 1) return Effect.succeed(only);
  return Effect.fail(
    userError(
      credentialed.length === 0
        ? "No declared Provider takes a credential."
        : `Choose a Provider with --provider: ${credentialed.map((p) => p.id).join(", ")}`,
    ),
  );
};

const AuthCapabilityModule = Schema.Struct({ authenticate: Schema.declare(Predicate.isFunction) });

/** Line input for an Auth capability, opened only if it asks for a line. */
const lineInput = () => {
  let reader: Interface | undefined;
  let lines: AsyncIterator<string> | undefined;
  return {
    input: async () => {
      reader ??= createInterface({ input: process.stdin, crlfDelay: Infinity });
      lines ??= reader[Symbol.asyncIterator]();
      const next = await lines.next();
      return next.done === true ? undefined : next.value;
    },
    close: () => reader?.close(),
  };
};

/**
 * Logs in or out with the selected Provider. Environment credentials are only explained: the CLI
 * neither stores them nor changes the calling shell. An Auth capability is imported from the
 * module the Provider names and runs against the application's credential directory, the one its
 * Providers read; it may need network access and a browser.
 */
export const authenticate = (
  operation: "login" | "logout",
  file: string,
  providerId: Option.Option<string>,
) =>
  Effect.gen(function* () {
    const app = yield* loadApplication(file);
    const provider = yield* selectCredentialed(app, providerId);
    const credential = provider.credential;
    if (credential === undefined) {
      return yield* Console.log(`${provider.id} needs no credential.`);
    }
    if (Predicate.isString(credential)) {
      return yield* Console.log(
        operation === "login"
          ? `${provider.id} reads its API key from ${credential}. Set it in the environment that runs the application, for example: export ${credential}=<key>. Mitome does not store it.`
          : `${provider.id} reads its API key from ${credential}. Remove it from that environment, for example: unset ${credential}.`,
      );
    }
    const directory = app.configDirectory ?? configDirectory();
    if (directory === undefined) {
      return yield* userError(`No credential directory. ${configDirectoryMessage}`);
    }
    const capability = yield* Effect.tryPromise({
      try: (): Promise<typeof Schema.Unknown.Type> => import(credential.capability.module),
      catch: (cause) =>
        userError(`Could not load the ${provider.id} auth capability: ${describe(cause)}`, cause),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(AuthCapabilityModule)),
      Effect.mapError((cause) =>
        cause instanceof CliError.UserError
          ? cause
          : userError(`The ${provider.id} auth capability does not export authenticate`, cause),
      ),
    );
    // SAFETY: a Provider's capability module implements Core's AuthCapability contract; its
    // shape was checked above and its Promise is adapted only at this boundary.
    const run = capability.authenticate as AuthCapability["authenticate"];
    yield* Effect.acquireUseRelease(
      Effect.sync(lineInput),
      ({ input }) =>
        Effect.tryPromise({
          try: () =>
            run({
              operation,
              configDirectory: directory,
              input,
              output: (text) => void process.stdout.write(text),
            }),
          catch: (cause) => userError(`${provider.id} ${operation} failed: ${describe(cause)}`),
        }),
      ({ close }) => Effect.sync(close),
    );
  });
