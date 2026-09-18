import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Extension } from "@mitome/core";

type Letter =
  | "a"
  | "b"
  | "c"
  | "d"
  | "e"
  | "f"
  | "g"
  | "h"
  | "i"
  | "j"
  | "k"
  | "l"
  | "m"
  | "n"
  | "o"
  | "p"
  | "q"
  | "r"
  | "s"
  | "t"
  | "u"
  | "v"
  | "w"
  | "x"
  | "y"
  | "z";
type DriveLetter = Letter | Uppercase<Letter>;

/**
 * A path that is absolute on some platform: POSIX-rooted, Windows-rooted or UNC, or a Windows
 * drive path. The runtime still applies the host `isAbsolute`, so a Windows form on POSIX throws.
 */
type AbsolutePath =
  | `/${string}`
  | `\\${string}`
  | `${DriveLetter}:/${string}`
  | `${DriveLetter}:\\${string}`;

/**
 * Options for `instructionFiles`. Relative `paths` need `base`, the calling module's
 * `import.meta.url`; absolute `paths` and `discover` do not.
 */
export type InstructionFilesOptions =
  | {
      /** The calling module's `import.meta.url`; relative `paths` resolve against its directory. */
      readonly base: string;
      /** Files to read, resolved against `base`. */
      readonly paths?: ReadonlyArray<string>;
      /** Bare filenames looked up in every directory from the git root down to the working directory. */
      readonly discover?: ReadonlyArray<string>;
    }
  | {
      readonly base?: never;
      /** Absolute files to read. */
      readonly paths?: ReadonlyArray<AbsolutePath>;
      /** Bare filenames looked up in every directory from the git root down to the working directory. */
      readonly discover?: ReadonlyArray<string>;
    };

const discoveryDirectories = (): ReadonlyArray<string> => {
  const cwd = process.cwd();
  const directories = [cwd];
  let directory = cwd;
  while (!existsSync(resolve(directory, ".git"))) {
    const parent = dirname(directory);
    if (parent === directory) return [cwd];
    directories.push(parent);
    directory = parent;
  }
  return directories.reverse();
};

const explicitPaths = ({ base, paths = [] }: InstructionFilesOptions): ReadonlyArray<string> => {
  if (base !== undefined) {
    const directory = dirname(fileURLToPath(base));
    return paths.map((path) => resolve(directory, path));
  }
  for (const path of paths) {
    if (!isAbsolute(path)) {
      throw new Error(`instructionFiles() needs \`base\` to resolve a relative path: ${path}`);
    }
  }
  return paths.map((path) => resolve(path));
};

const discoveredPaths = (names: ReadonlyArray<string>): ReadonlyArray<string> => {
  for (const name of names) {
    if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
      throw new Error(`Discovered instruction file must be a bare filename: ${name}`);
    }
  }
  const paths: Array<string> = [];
  for (const directory of discoveryDirectories()) {
    for (const name of names) {
      const path = resolve(directory, name);
      if (existsSync(path)) paths.push(path);
    }
  }
  return paths;
};

/**
 * Creates an Extension whose Instructions are read from files when the definition loads. A missing
 * `paths` entry throws; missing `discover` names are skipped.
 */
export function instructionFiles(options: InstructionFilesOptions = {}): Extension {
  const paths = explicitPaths(options);
  const files = [
    ...paths,
    ...discoveredPaths(options.discover ?? []).filter((path) => !paths.includes(path)),
  ];
  const fragments = files.map((path) => readFileSync(path, "utf8"));
  return fragments.length === 0 ? {} : { instructions: fragments.join("\n\n") };
}
