import { Effect, Predicate, Runtime, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { AuthenticateOptions } from "@mitome/core";
import { defaultProfile, invalidProfileName, isProfileName } from "./profile.js";

/** `ant` did not sign the profile in or out; the message says why. */
export class AntError extends Schema.TaggedError<AntError, { readonly brand: unique symbol }>()(
  "AntError",
  { message: Schema.String },
) {}

/**
 * Runs Anthropic's CLI to sign the Provider's profile in or out. The terminal is passed through, so
 * its browser flow and prompts work. A non-zero exit fails, carrying `ant`'s exit status for the
 * Host to exit with, and interruption stops `ant` and waits for it to exit.
 */
/** How long an interrupted `ant` gets to stop by itself before it is killed. */
const stopGrace = "2 seconds";

export const runAnt = Effect.fnUntraced(function* (options: AuthenticateOptions) {
  const { operation } = options;
  const profile = options.profile ?? defaultProfile;
  if (!isProfileName(profile)) return yield* new AntError({ message: invalidProfileName(profile) });
  // One argument: `ant` stops parsing flags when any argument is `__complete`
  // (`cmd/ant/main.go`), and a name starting with `-` could read as a flag of its own.
  const args = ["auth", operation, `--profile=${profile}`];
  if (operation === "login") {
    if (options.openBrowser === false) args.push("--no-browser");
    // `ant` activates a profile named on its command line (`cmd_auth.go`), and other Anthropic
    // tools that name none follow the active one.
    options.output(
      `\`ant auth login --profile=${profile}\` also makes "${profile}" the active profile of \`ant\`, so other Anthropic tools that name no profile will use it; switch back with \`ant profile activate <name>\`.\n`,
    );
  }
  const command = `ant ${args.join(" ")}`;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const code = yield* Effect.scoped(
    Effect.gen(function* () {
      const ant = yield* spawner
        .spawn(
          ChildProcess.make("ant", args, {
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
            // As `spawn` starts it: in the terminal's process group, since a background group that
            // reads the terminal is stopped, and with its console shown.
            detached: false,
            windowsHide: false,
            // An interruption that lands before the handle exists reaches only the spawner's own
            // cleanup, which otherwise waits for `ant` without limit.
            forceKillAfter: stopGrace,
          }),
        )
        .pipe(
          Effect.mapError(
            (error) =>
              new AntError({
                message: Predicate.isTagged(error.reason, "NotFound")
                  ? `The Claude Console sign-in runs \`ant\`, Anthropic's CLI, which is not installed or not on PATH. Install it from https://github.com/anthropics/anthropic-cli (for example \`brew install anthropics/tap/ant\`), then run \`mitome auth ${operation} --provider anthropic\` again.`
                  : Predicate.isError(error.cause)
                    ? error.cause.message
                    : error.message,
              }),
          ),
        );
      return yield* ant.exitCode.pipe(
        // Waiting reaps `ant`, so a Host that exits right after interruption leaves nothing
        // behind; an `ant` that ignores SIGTERM is killed, so interruption always ends.
        Effect.onInterrupt(() =>
          ant.kill().pipe(
            Effect.timeoutOrElse({
              duration: stopGrace,
              orElse: () => ant.kill({ killSignal: "SIGKILL" }),
            }),
            Effect.ignore,
          ),
        ),
        Effect.mapError((error) => {
          // TODO: read the signal from the error once the spawner reports it as a field.
          // The spawner names the signal that stopped a process only in its message.
          const signal = /signal: '(\w+)'/.exec(String(error.cause))?.[1] ?? "a signal";
          return new AntError({ message: `${command} was stopped by ${signal}.` });
        }),
      );
    }),
  );
  if (code === 0) return;
  return yield* Object.assign(new AntError({ message: `${command} exited with status ${code}.` }), {
    [Runtime.errorExitCode]: code,
  });
});
