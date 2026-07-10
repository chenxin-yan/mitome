import { posix, win32 } from "node:path";

/** Resolves Mitome's shared Definition and Credential directory without reading process globals. */
export const resolveConfigDirectory = (
  env: Readonly<Record<string, string | undefined>>,
  platform: string,
): string => {
  const path = platform === "win32" ? win32 : posix;
  const root =
    env.XDG_CONFIG_HOME ||
    (platform === "win32" ? env.APPDATA : env.HOME && path.join(env.HOME, ".config"));
  if (root === undefined || root === "") {
    throw new Error("Set XDG_CONFIG_HOME, APPDATA (on Windows), or HOME to locate Mitome config.");
  }
  return path.join(root, "mitome");
};
