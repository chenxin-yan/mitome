import { Effect, Option } from "effect";
import { ChildHost } from "../child-host.js";
import { checkRuntime, definitionPath } from "../definition.js";
import { attempt } from "../support.js";

export const runPrompt = ({
  prompt,
  use,
}: {
  readonly prompt: string;
  readonly use: Option.Option<string>;
}) =>
  Effect.gen(function* () {
    const childHost = yield* ChildHost;
    const path = yield* attempt(() => definitionPath(use));
    yield* attempt(() => checkRuntime(path));
    return yield* childHost.runHost(path, prompt);
  });

export const runInstall = ({ use }: { readonly use: Option.Option<string> }) =>
  Effect.gen(function* () {
    const childHost = yield* ChildHost;
    const path = yield* attempt(() => definitionPath(use));
    return yield* childHost.install(path);
  });
