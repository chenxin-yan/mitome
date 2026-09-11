import { join } from "node:path";

/**
 * Resolves Mitome's shared config directory (`$MITOME_HOME` verbatim, else
 * `$XDG_CONFIG_HOME/mitome`, with APPDATA/HOME fallbacks). Consumers store
 * their own files under it: the CLI's default `index.ts` and `.env`, and
 * provider-owned credential stores like `auth.json`. Undefined when no config
 * root is set. `env`/`platform` are injectable so tests need no process globals.
 */
export const configDirectory = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: string = process.platform,
): string | undefined => {
  if (env.MITOME_HOME) return env.MITOME_HOME;
  const root =
    env.XDG_CONFIG_HOME ||
    (platform === "win32" ? env.APPDATA : env.HOME && join(env.HOME, ".config"));
  return root ? join(root, "mitome") : undefined;
};

/** The canonical remedy shown when no config root is set. */
export const configDirectoryMessage =
  "Set MITOME_HOME, XDG_CONFIG_HOME, APPDATA (on Windows), or HOME.";
