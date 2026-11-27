// TODO: use `FileSystem` once it can remove a directory only when it is empty.
// FileSystem has no remove-only-if-empty: `remove` refuses a directory without `recursive`, and
// with it would delete what another process added.
import { rmdir } from "node:fs/promises";
import { Effect, FileSystem, Path, Predicate } from "effect";
import {
  exampleAgentSource,
  gitignoreSource,
  pinnedDependencies,
  type ProviderChoice,
} from "create-mitome/template";
import { runtimeError } from "./errors.js";

export interface InitOptions {
  readonly provider: ProviderChoice;
  readonly model: string;
}

export type FileMap = ReadonlyMap<string, string>;

export type Shell = "posix" | "powershell";

export const shellQuote = (path: string, shell: Shell): string =>
  shell === "powershell"
    ? // PowerShell also takes the typographic single quotes as quote delimiters.
      `'${path.replace(/['\u2018-\u201b]/g, "$&$&")}'`
    : /^[\w@%+=:,./-]+$/.test(path)
      ? path
      : `'${path.replaceAll("'", "'\\''")}'`;

/** How `provider` gets its credential, as a command to run before `mitome`: its API key if it takes one. */
export const signIn = (provider: ProviderChoice, shell: Shell): string =>
  provider.signIn !== undefined && provider.apiKeyEnv === undefined
    ? provider.signIn.command
    : shell === "powershell"
      ? `$env:${provider.apiKeyEnv} = "your key"`
      : `export ${provider.apiKeyEnv}="your key"`;

/**
 * Installs a Configuration's dependencies with `executable` (a word of `shell`) acting as Bun's
 * own installer, so no separate package manager is needed. PowerShell has no per-command
 * environment, so the variable is removed again: left set, every later `mitome` would act as Bun.
 */
export const installCommand = (executable: string, shell: Shell): string =>
  shell === "powershell"
    ? `$env:BUN_BE_BUN = "1"; & ${executable} install; Remove-Item Env:BUN_BE_BUN`
    : `BUN_BE_BUN=1 ${executable} install`;

/** The shell of this platform, which printed commands are written for. */
export const shell: Shell = process.platform === "win32" ? "powershell" : "posix";

/** What installs a Configuration's dependencies: the running executable, as `mitome init` does. */
export const liveInstallCommand = (): string =>
  installCommand(shellQuote(process.execPath, shell), shell);

const configurationSource = ({ provider, model }: InitOptions): string =>
  `import { Mitome } from "@mitome/core";
${provider.import}
import { agent } from "./agent.js";

export default Mitome.make({
  agent,
  providers: [${provider.factory}],
  model: ${JSON.stringify(`${provider.id}/${model}`)},
});
`;

const agentPackageSource = (): string =>
  `${JSON.stringify(
    {
      name: "mitome-agent",
      private: true,
      type: "module",
      dependencies: pinnedDependencies,
    },
    null,
    2,
  )}\n`;

const tsconfigSource = `${JSON.stringify(
  {
    compilerOptions: {
      target: "ESNext",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      // Effect's transitive declarations (msgpackr) reference Node globals; a fresh project
      // has no @types/node, so checking them would fail before any user code is reached.
      skipLibCheck: true,
    },
    include: ["**/*.ts"],
  },
  null,
  2,
)}\n`;

const credentialSource = ({ apiKeyEnv }: ProviderChoice): string =>
  apiKeyEnv === undefined
    ? "Sign in with your ChatGPT account; the login is stored in Mitome's state directory:"
    : `Set \`${apiKeyEnv}\` in the environment that runs \`mitome\`; Mitome does not store it:`;

const readmeSource = (provider: ProviderChoice): string => `# Mitome Configuration

This directory is Mitome's default Configuration: \`mitome\` loads \`index.ts\` here when no \`--config\` is given. Keep it in Git to use the same Agent on another machine.

- \`agent.ts\` describes the Agent: its Instructions and the Extensions it uses. The \`dice\` Extension adds a \`roll\` Tool that needs Approval.
- \`index.ts\` is the Configuration: the Agent with the Providers and the Model it runs with.

## Sign in

${credentialSource(provider)}

\`\`\`sh
${signIn(provider, "posix")}
\`\`\`
${
  provider.apiKeyEnv === undefined
    ? ""
    : `
In PowerShell:

\`\`\`powershell
${signIn(provider, "powershell")}
\`\`\`
`
}${
  provider.apiKeyEnv === undefined || provider.signIn === undefined
    ? ""
    : `
Or sign in instead; an API key in the environment takes precedence:

\`\`\`sh
${provider.signIn.command}
\`\`\`
`
}
## Run

\`\`\`sh
mitome                    # opens the terminal
mitome run "Roll a die."  # runs once and prints the result
\`\`\`

A Tool that needs Approval is asked about in the terminal (\`mitome\`) and denied in \`mitome run\`, which tells the Model and finishes.

After cloning this directory, install its dependencies by running \`${installCommand("mitome", "posix")}\` in it (in PowerShell: \`${installCommand("mitome", "powershell")}\`).

${
  provider.id === "anthropic"
    ? "Mitome uses `ant`'s profile, not a separate Mitome credential store, and the sign-in is not kept here: Anthropic's CLI, `ant`, owns it and keeps it in its `mitome` profile, in Anthropic's config directory (`ANTHROPIC_CONFIG_DIR` if set; otherwise `$XDG_CONFIG_HOME/anthropic` or `~/.config/anthropic`, and on Windows `%APPDATA%\\Anthropic` or `%USERPROFILE%\\AppData\\Roaming\\Anthropic`)."
    : "Logins are stored in Mitome's state directory (by default `~/.local/state/mitome`), not here. `MITOME_HOME` puts the config and state directories in the same directory on purpose; set, it puts `auth.json` next to `index.ts`, which is why `.gitignore` ignores it."
}
`;

export const configurationPlan = (options: InitOptions): FileMap =>
  new Map([
    ["package.json", agentPackageSource()],
    ["agent.ts", exampleAgentSource],
    ["index.ts", configurationSource(options)],
    ["tsconfig.json", tsconfigSource],
    [".gitignore", gitignoreSource],
    ["README.md", readmeSource(options.provider)],
  ]);

/** Fails, naming the directory, unless it is missing or empty. */
export const ensureEmpty = Effect.fnUntraced(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.readDirectory(directory).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])),
    Effect.mapError(runtimeError),
    Effect.filterOrFail(
      (entries) => entries.length === 0,
      () => new Error(`${directory} is not empty`),
    ),
  );
});

/**
 * Writes every file of `plan` into `directory`, or none: when one cannot be created, or it is
 * interrupted before the last one, the files and directories this call created are removed again.
 * Nothing that existed is overwritten.
 */
export const writeConfiguration = Effect.fnUntraced(function* (directory: string, plan: FileMap) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* ensureEmpty(directory);

  const missing: Array<string> = [];
  for (
    let at = directory;
    !(yield* fs.exists(at).pipe(Effect.mapError(runtimeError)));
    at = path.dirname(at)
  ) {
    missing.unshift(at);
    // A root that does not exist, such as a missing drive, is its own parent; making it says why.
    if (path.dirname(at) === at) break;
  }
  const made: Array<string> = [];
  const written: Array<string> = [];
  yield* Effect.gen(function* () {
    // A config directory holds code `mitome` runs, so one created here is private to the user
    // (the XDG base directory rule); an existing one keeps its mode. Created one at a time from the
    // top and recorded as made, so that exactly those are removed again.
    for (const at of missing) {
      yield* fs.makeDirectory(at, { mode: 0o700 }).pipe(
        Effect.andThen(Effect.sync(() => void made.push(at))),
        // Another process created it after the check: it is not this call's.
        Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.void),
        Effect.mapError(runtimeError),
        Effect.uninterruptible,
      );
    }
    for (const [file, contents] of plan) {
      const target = path.join(directory, file);
      // Uninterruptible, so a file is recorded once created and an interruption lands between files.
      yield* Effect.gen(function* () {
        // Exclusive creation is the guarantee; the preflight above is only the friendly diagnostic.
        const handle = yield* fs.open(target, { flag: "wx" });
        written.push(target);
        yield* handle.writeAll(new TextEncoder().encode(contents));
      }).pipe(
        Effect.scoped,
        Effect.mapError((error) =>
          Predicate.isTagged(error.reason, "AlreadyExists")
            ? new Error(`${target} already exists`)
            : runtimeError(error),
        ),
        Effect.uninterruptible,
      );
    }
  }).pipe(
    Effect.onError(() =>
      Effect.gen(function* () {
        yield* Effect.forEach(written, (file) => Effect.ignore(fs.remove(file, { force: true })), {
          concurrency: "unbounded",
          discard: true,
        });
        // Deepest first; rmdir leaves one that gained someone else's entry, and so those above it.
        for (const at of made.toReversed()) {
          const removed = yield* Effect.promise(() =>
            rmdir(at).then(
              () => true,
              () => false,
            ),
          );
          if (!removed) break;
        }
      }),
    ),
  );
});
