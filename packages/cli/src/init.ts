import { configDirectory, configDirectoryMessage } from "@mitome/core";
import { Console, Context, Effect, FileSystem, Option, Path, Schema, Stdio } from "effect";
import { Prompt } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  customModel,
  knownModelIds,
  modelChoices,
  pinnedDependencies,
  providerChoices,
  validateModelId,
} from "create-mitome/template";
import type { ProviderChoice } from "create-mitome/template";
import { describe, runtimeError, userError } from "./errors.js";
import {
  configurationPlan,
  ensureEmpty,
  liveInstallCommand,
  shell,
  signIn,
  writeConfiguration,
} from "./template.js";

/** Installs the dependencies a written Configuration declares, in its directory. */
export interface InstallerService {
  /** Fails with why, in a few words. */
  readonly install: (
    directory: string,
  ) => Effect.Effect<void, string, ChildProcessSpawner.ChildProcessSpawner>;
}

/** The running executable, acting as Bun's installer (`BUN_BE_BUN=1`); see `installCommand`. */
const selfInstaller: InstallerService = {
  install: Effect.fnUntraced(function* (directory: string) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const exitCode = yield* spawner
      .exitCode(
        ChildProcess.make(process.execPath, ["install"], {
          cwd: directory,
          env: { BUN_BE_BUN: "1" },
          extendEnv: true,
          stdin: "ignore",
          stdout: "inherit",
          stderr: "inherit",
        }),
      )
      .pipe(Effect.mapError(describe));
    if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
      return yield* Effect.fail(`the installer exited with code ${exitCode}`);
    }
  }),
};

export const Installer = Context.Reference<InstallerService>("@mitome/cli/Installer", {
  defaultValue: () => selfInstaller,
});

export interface InitOptions {
  readonly provider: Option.Option<ProviderChoice>;
  readonly model: Option.Option<string>;
  readonly noInstall: boolean;
}

/**
 * The version of `name` installed where the Configuration in `directory` resolves it: in the
 * `node_modules` of that directory or of any parent, as a hoisting workspace installs it. The walk
 * starts at the real path, as module resolution does.
 */
const installedVersion = Effect.fnUntraced(function* (directory: string, name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const real = yield* fs.realPath(directory).pipe(Effect.mapError(runtimeError), Effect.orDie);
  for (let from = real; ; from = path.dirname(from)) {
    const manifest = path.join(from, "node_modules", name, "package.json");
    // Any error counts as absent, as for a module lookup.
    if (yield* fs.exists(manifest).pipe(Effect.orElseSucceed(() => false))) {
      return yield* fs.readFileString(manifest).pipe(
        Effect.map((text) => Option.getOrUndefined(manifestVersion(text))?.version),
        Effect.orElseSucceed(() => undefined),
      );
    }
    if (from === path.dirname(from)) {
      return undefined;
    }
  }
});

/** The version a package manifest names: none for malformed JSON and for any other shape alike. */
const manifestVersion = Schema.decodeOption(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
);

/** Why the installed packages are not the pinned ones, or undefined when they are. */
const installedMismatch = Effect.fnUntraced(function* (directory: string) {
  const found = yield* Effect.forEach(Object.entries(pinnedDependencies), ([name, version]) =>
    Effect.map(installedVersion(directory, name), (installed) => ({ name, version, installed })),
  );
  const wrong = found.filter(
    ({ version, installed }) => installed !== undefined && installed !== version,
  );
  if (wrong.length > 0) {
    return wrong
      .map(({ name, version, installed }) => `expected ${name}@${version}, found ${installed}`)
      .join("; ");
  }
  return found.some(({ installed }) => installed === undefined)
    ? "the installer reported success but installed nothing (a dry-run or skip-install setting)"
    : undefined;
});

const modelPrompt = (provider: ProviderChoice): Prompt.Prompt<string> =>
  Prompt.Select<string | typeof customModel>({
    message: "Model",
    choices: modelChoices(knownModelIds[provider.id]).map(({ label, value }) => ({
      title: label,
      value,
    })),
  }).pipe(
    Prompt.flatMap((selected) =>
      selected === customModel
        ? Prompt.String({
            message: "Model ID",
            validate: (value) => {
              const id = validateModelId(value);
              return id === undefined ? Effect.fail("Model ID is required") : Effect.succeed(id);
            },
          })
        : Prompt.succeed(selected),
    ),
  );

const choose = Effect.fnUntraced(function* (options: InitOptions) {
  const flagModel = Option.flatMapNullishOr(options.model, validateModelId);
  if (Option.isSome(options.model) && Option.isNone(flagModel)) {
    return yield* userError("--model needs a Model id.");
  }
  if (Option.isSome(options.provider) && Option.isSome(flagModel)) {
    return { provider: options.provider.value, model: flagModel.value };
  }
  const stdio = yield* Stdio.Stdio;
  if (!(yield* stdio.stdinIsTerminal) || !(yield* stdio.stdoutIsTerminal)) {
    return yield* userError(
      "mitome init asks for the Provider and Model on a terminal; without one, pass both --provider <id> and --model <id>.",
    );
  }
  const providerPrompt = Option.isSome(options.provider)
    ? Prompt.succeed(options.provider.value)
    : Prompt.Select({
        message: "Provider",
        choices: providerChoices.map((choice) => ({ title: choice.label, value: choice })),
      });
  // One run for both questions: each run reads its own input, so keys typed ahead of the second
  // question would be lost between two runs.
  return yield* Prompt.run(
    providerPrompt.pipe(
      Prompt.flatMap((provider) =>
        (Option.isSome(flagModel) ? Prompt.succeed(flagModel.value) : modelPrompt(provider)).pipe(
          Prompt.map((model) => ({ provider, model })),
        ),
      ),
    ),
  ).pipe(
    Effect.mapError(() => userError("No Provider and Model were chosen; nothing was written.")),
  );
});

const refusal = (cause: unknown) =>
  userError(
    `mitome init writes the default Configuration only into a missing or empty directory, and changed nothing: ${describe(cause)}`,
    cause,
  );

export const initConfiguration = Effect.fnUntraced(function* (options: InitOptions) {
  const directory = configDirectory();
  if (directory === undefined) {
    return yield* userError(
      `No config directory for the default Configuration. ${configDirectoryMessage}`,
    );
  }
  // Checked before asking anything, so nobody answers questions for a write that cannot happen.
  yield* ensureEmpty(directory).pipe(Effect.mapError(refusal));
  const choice = yield* choose(options);
  // An interruption (a signal) stops the writer at the next file and waits while it removes what
  // it wrote, so the process never exits with part of a Configuration on disk.
  yield* writeConfiguration(directory, configurationPlan(choice)).pipe(
    Effect.mapError((cause) =>
      userError(
        `Could not write the default Configuration to ${directory}: ${describe(cause)}`,
        cause,
      ),
    ),
  );
  const { apiKeyEnv, signIn: alternative } = choice.provider;
  const nextSteps = [
    signIn(choice.provider, shell),
    ...(apiKeyEnv !== undefined && alternative !== undefined
      ? [`or sign in instead: ${alternative.command}`]
      : []),
    "mitome",
  ];
  const install = liveInstallCommand();
  if (options.noInstall) {
    return yield* Console.log(
      [
        `Wrote the default Configuration to ${directory}. Its dependencies are not installed (--no-install); install them by running this in ${directory}:`,
        `  ${install}`,
        "Then:",
        ...nextSteps.map((step) => `  ${step}`),
      ].join("\n"),
    );
  }
  const installer = yield* Installer;
  yield* installer.install(directory).pipe(
    // Exit 0 is not enough: a dry-run or skip-install setting reports success too, and a
    // workspace override can install another version.
    Effect.flatMap(() => installedMismatch(directory)),
    Effect.flatMap((mismatch) => (mismatch === undefined ? Effect.void : Effect.fail(mismatch))),
    Effect.mapError((reason) =>
      userError(
        `Wrote the default Configuration to ${directory}, but its dependencies are not installed: ${reason}. Install them by running this in ${directory}: ${install}`,
      ),
    ),
    Effect.onInterrupt(() =>
      Console.error(
        `Interrupted: wrote the default Configuration to ${directory}, but its dependencies may not be installed. Install them by running this in ${directory}: ${install}`,
      ),
    ),
  );
  yield* Console.log(
    [
      `Wrote the default Configuration to ${directory} and installed its dependencies. Next:`,
      ...nextSteps.map((step) => `  ${step}`),
    ].join("\n"),
  );
});
