import { Effect, Option } from "effect";
import { ChildHost } from "../child-host-service.js";
import { prepareDefinition } from "../definition.js";

export const runServe = Effect.fn("@mitome/cli/runServe")(function* ({
  port,
  use,
}: {
  readonly port: number;
  readonly use: Option.Option<string>;
}) {
  const prepared = yield* prepareDefinition(use);
  if ("exitCode" in prepared) return prepared.exitCode;
  const childHost = yield* ChildHost;
  return yield* childHost.serve(prepared.path, port);
});
