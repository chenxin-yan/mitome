import { Effect, Option } from "effect";
import { ChildHost } from "../child-host-service.js";
import { definitionPath } from "../definition.js";
import { attempt } from "../support.js";
import { reconcileDefinition } from "./run.js";

export const runServe = Effect.fn("@mitome/cli/runServe")(function* ({
  port,
  use,
}: {
  readonly port: number;
  readonly use: Option.Option<string>;
}) {
  const childHost = yield* ChildHost;
  const path = yield* attempt(() => definitionPath(use));
  const installExitCode = yield* reconcileDefinition(path);
  if (installExitCode !== 0) return installExitCode;
  return yield* childHost.serve(path, port);
});
