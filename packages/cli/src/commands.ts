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
 * Best-effort bound on shutdown, owned by the standalone CLI. A wall-clock timer starts on the
 * first SIGINT or SIGTERM, before the runtime begins interrupting, or through `start` once the
 * command's own work ends and its cleanup begins. If cleanup is still running when it fires, the
 * process exits nonzero without claiming cleanup finished. Settled cleanup removes the listeners
 * and the timer. A blocked event loop needs an external supervisor.
 */
const graceDeadline = (grace: number) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const start = () => {
        timer ??= setTimeout(() => {
          process.stderr.write(
            `mitome: shutdown did not finish within its ${grace}ms grace; exiting before cleanup completed\n`,
          );
          process.exit(1);
        }, grace);
      };
      process.prependListener("SIGINT", start);
      process.prependListener("SIGTERM", start);
      return { start, clear: () => clearTimeout(timer) };
    }),
    ({ start, clear }) =>
      Effect.sync(() => {
        process.off("SIGINT", start);
        process.off("SIGTERM", start);
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

/** What every executing command selects: the module, its Model and its shutdown grace. */
export interface ApplicationOptions {
  readonly app: string;
  readonly provider: Option.Option<string>;
  readonly model: Option.Option<string>;
  readonly grace: number;
}

export interface RunOptions extends ApplicationOptions {
  readonly input: Option.Option<string>;
}

/**
 * Runs `work` with the standalone grace: its shutdown is bounded once the work ends however it
 * ends, and from the first SIGINT or SIGTERM. `work` passes `onShutdown` to `acquire`.
 */
const withGrace = <A, E, R>(
  grace: number,
  work: (onShutdown: Effect.Effect<void>) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const deadline = yield* graceDeadline(grace);
      // The command's work ends here, however it ends; the Scope's cleanup then runs bounded.
      const startDeadline = Effect.sync(deadline.start);
      return yield* work(startDeadline).pipe(Effect.onExit(() => startDeadline));
    }),
  );

/** The module's CLI mapping, which executing commands require. */
const loadMapped = (file: string, command: string) =>
  Effect.gen(function* () {
    const app = yield* loadApplication(file);
    if (app.cli === undefined) {
      return yield* userError(
        `${app.path} declares no cli mapping (parseInput and renderResult), which mitome ${command} needs`,
      );
    }
    return { app, cli: app.cli };
  });

/** Acquires the application once and allocates the one Session the command keeps. */
const acquireSession = (
  app: LoadedApplication,
  options: ApplicationOptions,
  onShutdown: Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const application = yield* app
      .acquire({
        provider: Option.getOrUndefined(options.provider),
        model: Option.getOrUndefined(options.model),
        // Also bounds the unwind of a failed startup, which runs before acquire returns.
        onShutdown,
      })
      .pipe(failingWith("Could not start the application: "));
    const session = yield* application.session.pipe(failingWith(""));
    yield* Effect.addFinalizer(() => session.close);
    return { application, session };
  });

/**
 * One-shot execution: load, read input, acquire, allocate one fresh Session, parse, run one Turn,
 * render, then close the Session and shut down within the grace. A render failure after the Turn
 * committed is reported and never reruns the Turn.
 */
export const runApplication = (options: RunOptions) =>
  withGrace(options.grace, (onShutdown) =>
    Effect.gen(function* () {
      const { app, cli } = yield* loadMapped(options.app, "run");
      const text = yield* readInput(options.input);
      const { application, session } = yield* acquireSession(app, options, onShutdown);
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
    }),
  );

/**
 * Interactive execution over one acquired application and one retained Session, until the user
 * closes the terminal. It needs a terminal on stdin and stdout, checked before anything is loaded;
 * OpenTUI is imported only then. The terminal is restored before shutdown begins, and closing
 * exits like SIGINT, with shutdown bounded by the grace.
 */
export const runTerminalApplication = (options: ApplicationOptions) =>
  withGrace(options.grace, (onShutdown) =>
    Effect.gen(function* () {
      const stdio = yield* Stdio.Stdio;
      if (!(yield* stdio.stdinIsTerminal) || !(yield* stdio.stdoutIsTerminal)) {
        return yield* userError(
          "mitome tui needs a terminal on standard input and output; use mitome run otherwise.",
        );
      }
      const { app, cli } = yield* loadMapped(options.app, "tui");
      const { application, session } = yield* acquireSession(app, options, onShutdown);
      const approvals =
        cli.approvals === undefined
          ? undefined
          : yield* application
              .provide(cli.approvals)
              .pipe(failingWith("Could not open the application's Approval channel: "));
      const { runTerminal } = yield* Effect.promise(() => import("@mitome/tui"));
      yield* runTerminal({
        parseInput: (text) => application.provide(cli.parseInput(text)),
        run: session.run,
        renderResult: (result) => application.provide(cli.renderResult(result)),
        history: session.history,
        turns: session.turns,
        approvals,
      }).pipe(failingWith("The terminal failed: "));
      // The user closed the terminal: end like SIGINT, exiting 130 once shutdown settles.
      return yield* Effect.interrupt;
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
