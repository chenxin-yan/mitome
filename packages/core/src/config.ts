import { posix, win32 } from "node:path";

/**
 * Resolves Mitome's shared config directory (`$MITOME_HOME` verbatim, else
 * `$XDG_CONFIG_HOME/mitome`, with APPDATA/HOME fallbacks). Consumers store
 * their own files under it: the CLI's default `index.ts` and `.env`, and
 * provider-owned credential stores like `auth.json`. Pure of process globals;
 * undefined when no config root is set.
 */
export const resolveConfigDirectory = (
  env: Readonly<Record<string, string | undefined>>,
  platform: string,
): string | undefined => {
  if (env.MITOME_HOME) return env.MITOME_HOME;
  const path = platform === "win32" ? win32 : posix;
  const root =
    env.XDG_CONFIG_HOME ||
    (platform === "win32" ? env.APPDATA : env.HOME && path.join(env.HOME, ".config"));
  return root ? path.join(root, "mitome") : undefined;
};

/** The canonical remedy shown when no config root is set. */
export const configDirectoryMessage =
  "Set MITOME_HOME, XDG_CONFIG_HOME, APPDATA (on Windows), or HOME.";

/** Resolves the shared config directory from the current process environment. */
export const configDirectory = (): string | undefined =>
  resolveConfigDirectory(process.env, process.platform);
