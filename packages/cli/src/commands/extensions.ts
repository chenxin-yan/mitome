import { Console, Effect, Option } from "effect";
import { ChildHost } from "../child-host-service.js";
import { prepareDefinition } from "../definition.js";
import type { ExitCode } from "../support.js";

export const runExtensionList = Effect.fn("@mitome/cli/runExtensionList")(function* ({
  use,
}: {
  readonly use: Option.Option<string>;
}) {
  const prepared = yield* prepareDefinition(use);
  if ("exitCode" in prepared) return prepared.exitCode;
  const childHost = yield* ChildHost;
  const result = yield* childHost.inspectExtensions(prepared.path);
  if (result.exitCode !== 0) return result.exitCode;
  for (const extension of result.extensions) {
    yield* Console.log(`${extension.name}\t${extension.version}`);
  }
  return 0 satisfies ExitCode;
});
