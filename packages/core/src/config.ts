import { posix, win32 } from "node:path";

/**
 * Resolves Mitome's shared config directory (`$XDG_CONFIG_HOME/mitome`, with
 * APPDATA/HOME fallbacks). Consumers store their own files under it: the CLI's
 * default `agent.ts` and `.env`, and provider-owned credential stores like
 * `auth.json`. Pure of process globals; undefined when no config root is set.
 */
export const resolveConfigDirectory = (
  env: Readonly<Record<string, string | undefined>>,
  platform: string,
): string | undefined => {
  const path = platform === "win32" ? win32 : posix;
  const root =
    env.XDG_CONFIG_HOME ||
    (platform === "win32" ? env.APPDATA : env.HOME && path.join(env.HOME, ".config"));
  return root ? path.join(root, "mitome") : undefined;
};
