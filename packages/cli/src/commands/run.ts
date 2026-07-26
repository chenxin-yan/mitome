import { Effect, Option } from "effect";
import { install, runHost } from "../child-host.js";
import { checkRuntime, definitionPath } from "../definition.js";
import { attempt, waitForChild } from "../support.js";

export const runPrompt = ({
  prompt,
  use,
}: {
  readonly prompt: string;
  readonly use: Option.Option<string>;
}) =>
  Effect.gen(function* () {
    const path = yield* attempt(() => definitionPath(use));
    yield* attempt(() => checkRuntime(path));
    process.exitCode = yield* waitForChild(() => runHost(path, prompt));
  });

export const runInstall = ({ use }: { readonly use: Option.Option<string> }) =>
  Effect.gen(function* () {
    const path = yield* attempt(() => definitionPath(use));
    process.exitCode = yield* waitForChild(() => install(path));
  });
