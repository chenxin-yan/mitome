import { Effect, Option } from "effect";
import { ChildHost } from "../child-host-service.js";
import { definitionPath, prepareDefinition } from "../definition.js";
import { attempt, fail } from "../support.js";

export const runMessage = Effect.fn("@mitome/cli/runMessage")(function* ({
  print,
  message,
  use,
}: {
  readonly print: boolean;
  readonly message: Option.Option<string>;
  readonly use: Option.Option<string>;
}) {
  const messageValue = Option.getOrUndefined(message);
  const forcePrint = print || process.stdout.isTTY !== true;
  if (forcePrint && messageValue === undefined) {
    return yield* fail(
      "Missing argument message (one-shot output needs a message; interactive Sessions need a TTY without --print)",
    );
  }

  const prepared = yield* prepareDefinition(use);
  if ("exitCode" in prepared) return prepared.exitCode;
  const childHost = yield* ChildHost;
  return yield* childHost.runHost(prepared.path, messageValue, forcePrint ? "print" : "auto");
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
