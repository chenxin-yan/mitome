import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Extension } from "@mitome/core";

export interface InstructionFilesOptions {
  readonly paths?: ReadonlyArray<string>;
  readonly discover?: ReadonlyArray<string>;
}

const sourcePath = (fileName: string): string =>
  fileName.startsWith("file:") ? fileURLToPath(fileName) : fileName;

const callingModule = (): string => {
  // V8/Bun invokes this global hook without a receiver; preserve it across synchronous capture.
  // oxlint-disable-next-line @typescript-eslint/unbound-method
  const previous = Error.prepareStackTrace;
  try {
    let stack: ReadonlyArray<NodeJS.CallSite> = [];
    Error.prepareStackTrace = (_, callsites) => {
      stack = callsites;
      return callsites;
    };
    const error = new Error();
    Error.captureStackTrace(error, instructionFiles);
    void error.stack;
    for (const callsite of stack) {
      const fileName = callsite.getFileName() ?? callsite.getScriptNameOrSourceURL();
      if (fileName === null) continue;
      const path = sourcePath(fileName);
      if (isAbsolute(path)) return path;
    }
  } finally {
    Error.prepareStackTrace = previous;
  }
  throw new Error("Could not resolve the module calling instructionFiles().");
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

const explicitPaths = (paths: ReadonlyArray<string> | undefined): ReadonlyArray<string> => {
  if (paths === undefined) return [];
  const caller = dirname(callingModule());
  return paths.map((path) => resolve(caller, path));
};

const discoveredPaths = (names: ReadonlyArray<string>): ReadonlyArray<string> => {
  for (const name of names) {
    if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
      throw new Error(`Discovered instruction file must be a bare filename: ${name}`);
    }
  }
  return discoveryDirectories().flatMap((directory) =>
    names.map((name) => resolve(directory, name)).filter(existsSync),
  );
};

/**
 * Creates an Extension from synchronous instruction files at definition load time.
 * ADR-0024 intentionally confines these node:fs reads to this first-party SDK subpath.
 */
export function instructionFiles(options: InstructionFilesOptions = {}): Extension {
  const paths = explicitPaths(options.paths);
  const files = [
    ...paths,
    ...discoveredPaths(options.discover ?? []).filter((path) => !paths.includes(path)),
  ];
  const fragments = files.map((path) => readFileSync(path, "utf8"));
  return fragments.length === 0 ? {} : { instructions: fragments.join("\n\n") };
}
