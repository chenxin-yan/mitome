// A local Auth capability: it records the operation and directory instead of contacting anyone.
import { appendFileSync } from "node:fs";
import type { AuthCapability } from "@mitome/core";

export const authenticate: AuthCapability["authenticate"] = async (options) => {
  const file = process.env.MITOME_FIXTURE_LOG;
  if (file !== undefined)
    appendFileSync(file, `auth:${options.operation}:${options.configDirectory}\n`);
  options.output(`${options.operation} done\n`);
};
