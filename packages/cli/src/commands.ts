import {
  type AuthCapability,
  type AuthenticateOptions,
  type Mitome,
  stateDirectory,
  stateDirectoryMessage,
  Transcripts,
} from "@mitome/core";
import {
  Cause,
  Console,
  Effect,
  Option,
  Path,
  Predicate,
  Queue,
  Schema,
  Scope,
  Stdio,
  Stream,
} from "effect";
import { CliError } from "effect/cli";
import {
  loadConfiguration,
  type LoadedConfiguration,
  type LoadedInstance,
} from "./configuration.js";
import { describe, runtimeError, userError } from "./errors.js";
// makeApprovals allocates the terminal Host's own channel; it needs no service to provide.
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports
import { makeApprovals } from "./terminal/approvals.js";

// TODO: split this file into one file per command when the next command is added. It is named
// for a mechanism, and the rest of the codebase groups files by domain.

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
const readInput = Effect.fnUntraced(function* (input: Option.Option<string>) {
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
const writeResult = Effect.fnUntraced(function* (text: string) {
  const stdio = yield* Stdio.Stdio;
  const output = text === "" || text.endsWith("\n") ? text : `${text}\n`;
  yield* Stream.make(output).pipe(
    Stream.run(stdio.stdout()),
    Effect.mapError((cause) => userError(`Could not write the result: ${describe(cause)}`)),
  );
});

const failingWith = (prefix: string) =>
  Effect.mapError((cause: unknown) =>
    cause instanceof CliError.UserError ? cause : userError(`${prefix}${describe(cause)}`, cause),
  );

/**
 * What every executing command selects: the Configuration, its Model, its shutdown grace and the
 * conversation to continue.
 */
export interface ConfigurationOptions {
  readonly config: Option.Option<string>;
  readonly provider: Option.Option<string>;
  readonly model: Option.Option<string>;
  readonly grace: number;
  /** `--continue`: `""` for the conversation most recently written here, otherwise an id. */
  readonly continue: Option.Option<string>;
}

export interface RunOptions extends ConfigurationOptions {
  readonly input: Option.Option<string>;
}

/**
 * Runs `work` with the standalone grace: its shutdown is bounded once the work ends however it
 * ends, and from the first SIGINT or SIGTERM. `work` passes `onShutdown` to `acquire`.
 */
const withGrace = Effect.fnUntraced(function* <A, E, R>(
  grace: number,
  work: (onShutdown: Effect.Effect<void>) => Effect.Effect<A, E, R>,
) {
  const deadline = yield* graceDeadline(grace);
  // The command's work ends here, however it ends; the Scope's cleanup then runs bounded.
  const startDeadline = Effect.sync(deadline.start);
  return yield* work(startDeadline).pipe(Effect.onExit(() => startDeadline));
}, Effect.scoped);

/** Acquires the Configuration once, with the Model the options select. */
const acquire = (
  configuration: LoadedConfiguration,
  options: ConfigurationOptions,
  onShutdown: Effect.Effect<void>,
) =>
  configuration
    .acquire({
      provider: Option.getOrUndefined(options.provider),
      model: Option.getOrUndefined(options.model),
      // Also bounds the unwind of a failed startup, which runs before acquire returns.
      onShutdown,
    })
    .pipe(failingWith("Could not start the Configuration: "));

/**
 * Allocates the one Session the command keeps, in a new conversation under `here`, the directory
 * the command started in, or in the one `--continue` selects. `conversation` names it for a person
 * when the Configuration keeps history, saying what was continued.
 */
const openSession = Effect.fnUntraced(function* (
  instance: LoadedInstance,
  options: ConfigurationOptions,
  here: string,
) {
  const id = Option.getOrUndefined(options.continue);
  const session = yield* instance
    .session({
      transcript: id === undefined ? { create: here } : id === "" ? { latest: here } : { open: id },
    })
    .pipe(
      // Raised by the Configuration's own copy of @mitome/core, so recognised by tag and reason.
      Effect.mapError((cause) =>
        !Predicate.isTagged(cause, "TranscriptSelectionError")
          ? cause
          : Predicate.hasProperty(cause, "reason") && cause.reason === "no-store"
            ? userError(
                "This Configuration keeps no history, so there is no conversation to continue.",
              )
            : userError(
                id === ""
                  ? `There is no conversation to continue in ${here}.`
                  : `There is no conversation "${id}" to continue.`,
              ),
      ),
      failingWith(""),
    );
  if (id === undefined) {
    const kept = yield* instance
      .provide(Effect.map(Transcripts, Predicate.isNotUndefined))
      .pipe(failingWith(""));
    return { session, conversation: kept ? `Conversation ${session.transcript}.` : undefined };
  }
  // The Entries of the Branch continued, from the root to the position.
  const parents = new Map(
    (yield* session.tree.pipe(failingWith("Could not read the conversation: "))).map((entry) => [
      entry.id,
      entry.parent,
    ]),
  );
  let entries = 0;
  for (
    let at = yield* session.position.pipe(failingWith(""));
    at !== undefined;
    at = parents.get(at)
  ) {
    entries += 1;
  }
  const counted = `${entries} ${entries === 1 ? "Entry" : "Entries"}`;
  return { session, conversation: `Continued conversation ${session.transcript} (${counted}).` };
});

/**
 * One-shot execution: load, read input, acquire, parse, allocate one fresh Session, run one Turn,
 * render, then close the Session and shut down within the grace. Input the Configuration rejects
 * starts no conversation. A render failure after the Turn committed is reported and never reruns
 * the Turn. No Approver is provided: nobody is present, so a Tool Call that needs Approval is
 * denied, the Model is told, and the Turn continues.
 */
export const runApplication = (options: RunOptions) =>
  withGrace(options.grace, (onShutdown) =>
    Effect.gen(function* () {
      // Read before the Configuration loads, since its code may change the working directory.
      const here = process.cwd();
      const configuration = yield* loadConfiguration(options.config);
      const text = yield* readInput(options.input);
      const instance = yield* acquire(configuration, options, onShutdown);
      const input = yield* instance
        .provide(configuration.text.parse(text))
        .pipe(failingWith("Could not parse the input: "));
      const { session, conversation } = yield* openSession(instance, options, here);
      // Only what was continued: a new conversation would add a line to every run's stderr.
      if (Option.isSome(options.continue) && conversation !== undefined) {
        yield* Console.error(conversation);
      }
      const result = yield* session.run(input).pipe(failingWith("The Agent failed: "));
      const rendered = yield* instance
        .provide(configuration.text.render(result))
        .pipe(failingWith("The Turn succeeded, but its result could not be rendered: "));
      if (!Predicate.isString(rendered)) {
        return yield* userError(
          "The Turn succeeded, but text.render did not produce a string; it is not rerun",
        );
      }
      yield* writeResult(rendered);
    }),
  );

/**
 * Interactive execution over one acquired Configuration and one retained Session, until the user
 * closes the terminal. It needs a terminal on stdin and stdout, checked before anything is loaded;
 * OpenTUI is imported only then. The terminal answers each Turn's Approvals. It is restored before
 * shutdown begins, and closing exits like SIGINT, with shutdown bounded by the grace.
 */
export const runTerminalApplication = (options: ConfigurationOptions) =>
  withGrace(options.grace, (onShutdown) =>
    Effect.gen(function* () {
      const stdio = yield* Stdio.Stdio;
      if (!(yield* stdio.stdinIsTerminal) || !(yield* stdio.stdoutIsTerminal)) {
        return yield* userError(
          "mitome needs a terminal on standard input and output; use mitome run otherwise.",
        );
      }
      // Read before the Configuration loads, since its code may change the working directory.
      const here = process.cwd();
      const configuration = yield* loadConfiguration(options.config);
      const instance = yield* acquire(configuration, options, onShutdown);
      const { session, conversation } = yield* openSession(instance, options, here);
      const approvals = yield* makeApprovals;
      const { runTerminal } = yield* Effect.promise(() => import("./terminal/terminal.js"));
      yield* runTerminal({
        parseInput: (text) => instance.provide(configuration.text.parse(text)),
        run: (input) => approvals.provideApprover(session.run(input)),
        renderResult: (result) => instance.provide(configuration.text.render(result)),
        history: session.history,
        turns: session.turns,
        approvals,
        conversation,
      }).pipe(
        failingWith("The terminal failed: "),
        // However it closed, a signal included, the terminal is restored by now and no longer
        // shows the id, and the Session is still open. An empty conversation has nothing to continue.
        Effect.ensuring(
          session.position.pipe(
            Effect.flatMap((position) =>
              conversation === undefined || position === undefined
                ? Effect.void
                : Console.error(
                    `Conversation ${session.transcript} is kept; continue it with mitome --continue=${session.transcript}`,
                  ),
            ),
            Effect.ignore,
          ),
        ),
      );
      // The user closed the terminal: end like SIGINT, exiting 130 once shutdown settles.
      return yield* Effect.interrupt;
    }),
  );

const modelHint = (provider: Mitome.ProviderDiscovery, modelId: string) => {
  const window = provider.models[modelId]?.contextWindow;
  return `  ${provider.id}/${modelId}${window === undefined ? "" : ` (context window ${window})`}`;
};

/** Lists declared Providers and their catalog hints; nothing is acquired or authenticated. */
export const listProviders = Effect.fnUntraced(function* (config: Option.Option<string>) {
  const app = yield* loadConfiguration(config);
  if (app.discovery.length === 0) return yield* Console.log("No Providers declared.");
  const lines = app.discovery.flatMap((provider) => [
    provider.id,
    ...[...new Set([...provider.modelIds, ...Object.keys(provider.models)])].map((modelId) =>
      modelHint(provider, modelId),
    ),
  ]);
  if (app.model !== undefined) lines.push(`default: ${app.model}`);
  lines.push("Catalogs are hints; any Provider-native Model id can be selected.");
  yield* Console.log(lines.join("\n"));
});

const findProvider = (app: LoadedConfiguration, id: string) => {
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
const credentialStatus = (provider: Mitome.ProviderDiscovery): string => {
  const credential = provider.credential;
  if (credential === undefined) return `${provider.id}: needs no credential`;
  if (Predicate.isString(credential)) {
    return `${provider.id}: ${credential} ${process.env[credential] ? "present" : "missing"}`;
  }
  return `${provider.id}: auth capability available; credential status unknown`;
};

export const authStatus = Effect.fnUntraced(function* (
  config: Option.Option<string>,
  providerId: Option.Option<string>,
) {
  const app = yield* loadConfiguration(config);
  const providers = Option.isSome(providerId)
    ? [yield* findProvider(app, providerId.value)]
    : app.discovery;
  yield* Console.log(
    providers.length === 0 ? "No Providers declared." : providers.map(credentialStatus).join("\n"),
  );
});

/** The Provider to authenticate: the one named, or the only one declaring a credential. */
const selectCredentialed = (app: LoadedConfiguration, providerId: Option.Option<string>) => {
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

/**
 * An Auth capability module named by a Provider, resolved as an import written in the
 * Configuration file would be: a relative specifier against its directory, a bare one from its own
 * `node_modules`. An absolute path or URL is used as given.
 */
const capabilityModule = Effect.fnUntraced(function* <E>(
  specifier: string,
  configuration: LoadedConfiguration,
  unloadable: (cause: unknown) => E,
) {
  const path = yield* Path.Path;
  if (path.isAbsolute(specifier) || URL.canParse(specifier)) return specifier;
  if (/^\.\.?\//.test(specifier)) {
    const base = yield* path
      .toFileUrl(configuration.realPath)
      .pipe(Effect.mapError((error) => unloadable(runtimeError(error))));
    return new URL(specifier, base).href;
  }
  return yield* Effect.try({
    try: () => Bun.resolveSync(specifier, path.dirname(configuration.realPath)),
    catch: unloadable,
  });
});

/** Line input for an Auth capability, opened only if it asks for a line, until `scope` closes. */
const lineInput = (stdio: Stdio.Stdio, scope: Scope.Scope) =>
  Effect.map(
    Effect.cached(
      stdio.stdin.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        // Bounded, so a long pipe is read only as fast as the capability asks for lines.
        Stream.toQueue({ capacity: 16 }),
        Scope.provide(scope),
      ),
    ),
    (lines) =>
      lines.pipe(
        Effect.flatMap(Queue.take),
        Effect.catchIf(Cause.isDone, () => Effect.undefined),
        Effect.mapError((error) =>
          userError(
            `Could not read standard input: ${describe(runtimeError(error))}`,
            runtimeError(error),
          ),
        ),
      ),
  );

/**
 * Logs in or out with the selected Provider. Environment credentials are only explained: the CLI
 * neither stores them nor changes the calling shell. An Auth capability is imported from the
 * module the Provider names and runs against the state directory, where every Configuration's
 * Providers read their stored Credentials; it may need network access and a browser, and is
 * interrupted when the command is.
 */
export const authenticate = Effect.fnUntraced(function* (
  operation: "login" | "logout",
  config: Option.Option<string>,
  providerId: Option.Option<string>,
) {
  const app = yield* loadConfiguration(config);
  const provider = yield* selectCredentialed(app, providerId);
  const credential = provider.credential;
  if (credential === undefined) {
    return yield* Console.log(`${provider.id} needs no credential.`);
  }
  if (Predicate.isString(credential)) {
    return yield* Console.log(
      `${provider.id} reads its API key from ${credential}. ${operation === "login" ? "Set it in" : "Remove it from"} the environment that runs mitome; Mitome does not store it.`,
    );
  }
  const directory = stateDirectory();
  if (directory === undefined) {
    return yield* userError(`No credential directory. ${stateDirectoryMessage}`);
  }
  const unloadable = (cause: unknown) =>
    userError(`Could not load the ${provider.id} auth capability: ${describe(cause)}`, cause);
  const capability = yield* capabilityModule(credential.capability.module, app, unloadable).pipe(
    Effect.flatMap((module) =>
      Effect.tryPromise({
        // oxlint-disable-next-line anti-slop/no-unknown-returns -- a foreign module, decoded on the next line
        try: async (): Promise<unknown> => import(module),
        catch: unloadable,
      }),
    ),
    Effect.flatMap(Schema.decodeUnknownEffect(AuthCapabilityModule)),
    Effect.mapError((cause) =>
      cause instanceof CliError.UserError
        ? cause
        : userError(`The ${provider.id} auth capability does not export authenticate`, cause),
    ),
  );
  const input = yield* lineInput(yield* Stdio.Stdio, yield* Scope.Scope);
  const options: AuthenticateOptions = {
    operation,
    stateDirectory: directory,
    input,
    output: (text) => void process.stdout.write(text),
  };
  const authenticating: unknown = capability.authenticate(options);
  if (!Effect.isEffect(authenticating)) {
    return yield* userError(
      `The ${provider.id} auth capability's authenticate did not return an Effect`,
    );
  }
  // SAFETY: a Provider's capability module implements @mitome/core's AuthCapability contract, checked
  // above only as far as returning an Effect.
  yield* (authenticating as ReturnType<AuthCapability["authenticate"]>).pipe(
    Effect.mapError((cause) => userError(`${provider.id} ${operation} failed: ${describe(cause)}`)),
  );
}, Effect.scoped);
