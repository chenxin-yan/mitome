import { Effect, Option } from "effect";
import { ChildHost } from "../child-host.js";
import { checkRuntime, definitionPath } from "../definition.js";
import { attempt } from "../support.js";

export const runPrompt = Effect.fn("@mitome/cli/runPrompt")(function* ({
  prompt,
  use,
}: {
  readonly prompt: string;
  readonly use: Option.Option<string>;
}) {
  const childHost = yield* ChildHost;
  const path = yield* attempt(() => definitionPath(use));
  yield* attempt(() => checkRuntime(path));
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
