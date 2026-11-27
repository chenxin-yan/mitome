// A local Auth capability: it records the operation and directory instead of contacting anyone, and
// keeps a marker file in the state directory while logged in. MITOME_FIXTURE_AUTH_HOLD makes it wait
// until it is interrupted, recording `auth:interrupted`.
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import type { AuthCapability } from "@mitome/core";
import { record } from "./record.ts";

export const authenticate: AuthCapability["authenticate"] = (options) =>
  Effect.suspend(() => {
    const file = process.env.MITOME_FIXTURE_LOG;
    if (file !== undefined)
      appendFileSync(file, `auth:${options.operation}:${options.stateDirectory}\n`);
    if (process.env.MITOME_FIXTURE_AUTH_HOLD !== undefined) {
      return Effect.onInterrupt(Effect.never, () => Effect.sync(() => record("auth:interrupted")));
    }
    const marker = join(options.stateDirectory, "fixture-login");
    if (options.operation === "login") {
      mkdirSync(options.stateDirectory, { recursive: true });
      writeFileSync(marker, "");
    } else rmSync(marker);
    options.output(`${options.operation} done\n`);
    return Effect.void;
  });
