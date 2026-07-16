import { posix, win32 } from "node:path";

/**
 * Resolves Mitome's shared Definition and Credential directory without reading
 * process globals; undefined when no config root variable is set.
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
