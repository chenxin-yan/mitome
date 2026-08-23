import { Console, Effect, Option } from "effect";
import { ChildHost } from "../child-host-service.js";
import { definitionPath } from "../definition.js";
import { attempt, type ExitCode } from "../support.js";
import { reconcileDefinition } from "./run.js";

export const runExtensionList = Effect.fn("@mitome/cli/runExtensionList")(function* ({
  use,
}: {
  readonly use: Option.Option<string>;
}) {
  const childHost = yield* ChildHost;
  const path = yield* attempt(() => definitionPath(use));
  const installExitCode = yield* reconcileDefinition(path);
  if (installExitCode !== 0) return installExitCode;

  const result = yield* childHost.inspectExtensions(path);
  if (result.exitCode !== 0) return result.exitCode;
  for (const extension of result.extensions) {
    const provenance = extension.direct
      ? "direct"
      : `dependency of ${extension.dependents.join(", ")}`;
    yield* Console.log(`${extension.name}\t${extension.version}\t${provenance}`);
  }
  return 0 satisfies ExitCode;
});
