import { Console, Effect, Option } from "effect";
import { ChildHost } from "../child-host.js";
import { checkRuntime, definitionNeedsReconcile, definitionPath } from "../definition.js";
import { attempt, type ExitCode } from "../support.js";

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
  prompt,
  use,
}: {
  readonly prompt: string;
  readonly use: Option.Option<string>;
}) {
  const childHost = yield* ChildHost;
  const path = yield* attempt(() => definitionPath(use));
  const installExitCode = yield* reconcileDefinition(path);
  if (installExitCode !== 0) return installExitCode;
  return yield* childHost.runHost(path, prompt);
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
