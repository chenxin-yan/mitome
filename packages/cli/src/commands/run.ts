import { Console, Effect, Option } from "effect";
import { ChildHost } from "../child-host.js";
import {
  checkRuntime,
  definitionNeedsReconcile,
  definitionPath,
  tuiInstalled,
} from "../definition.js";
import { attempt, fail, type ExitCode } from "../support.js";

export const reconcileDefinition = Effect.fn("@mitome/cli/reconcileDefinition")(function* (
  path: string,
) {
  const childHost = yield* ChildHost;
  if (!(yield* attempt(() => definitionNeedsReconcile(path)))) return 0 satisfies ExitCode;
  yield* Console.log("Installing Agent Definition dependencies...");
  const exitCode = yield* childHost.install(path);
  if (exitCode === 0) yield* attempt(() => checkRuntime(path));
  return exitCode;
});

export const runPrompt = Effect.fn("@mitome/cli/runPrompt")(function* ({
  print,
  prompt,
  use,
}: {
  readonly print: boolean;
  readonly prompt: Option.Option<string>;
  readonly use: Option.Option<string>;
}) {
  const childHost = yield* ChildHost;
  const path = yield* attempt(() => definitionPath(use));
  const installExitCode = yield* reconcileDefinition(path);
  if (installExitCode !== 0) return installExitCode;

  const hasTui = yield* attempt(() => tuiInstalled(path));
  const promptValue = Option.getOrUndefined(prompt);
  if (
    hasTui &&
    !print &&
    process.stdout.isTTY === true &&
    process.platform === "linux" &&
    process.env.TERM_PROGRAM?.toLowerCase() === "ghostty"
  ) {
    return yield* childHost.runTui(path, promptValue ?? "");
  }
  if (hasTui && !print && process.stdout.isTTY === true) {
    yield* Console.error(
      "@mitome/tui currently supports Ghostty on Linux; falling back to one-shot output.",
    );
  }
  if (promptValue === undefined) return yield* fail("Missing argument prompt");
  return yield* childHost.runHost(path, promptValue);
});

export const runInstall = Effect.fn("@mitome/cli/runInstall")(function* ({
  use,
}: {
  readonly use: Option.Option<string>;
}) {
  const childHost = yield* ChildHost;
  const path = yield* attempt(() => definitionPath(use));
  return yield* childHost.install(path);
});
