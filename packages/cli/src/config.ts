import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Result, Schema } from "effect";
import { configDirectory, configDirectoryMessage } from "@mitome/core";

const ErrorCode = Schema.Struct({ code: Schema.String });
export const errorCode = <Input>(error: Input): string | undefined => {
  const decoded = Schema.decodeUnknownResult(ErrorCode)(error);
  return Result.isSuccess(decoded) ? decoded.success.code : undefined;
};
export const isEnoent = <Input>(error: Input): boolean => errorCode(error) === "ENOENT";

const configEnvName = (line: string): string | undefined =>
  /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1];

const readConfigEnv = async (path: string): Promise<string> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    // Missing config .env is normal; other filesystem errors must remain visible.
    if (isEnoent(error)) return "";
    throw error;
  }
};

export const requireConfigDirectory = (): string => {
  const directory = configDirectory();
  if (directory === undefined) throw new Error(configDirectoryMessage);
  return directory;
};

const writeConfigEnv = async (contents: string): Promise<void> => {
  const directory = requireConfigDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = await mkdtemp(join(directory, ".env-"));
  const file = join(temporary, "value");
  try {
    await writeFile(file, contents, { mode: 0o600 });
    await rename(file, join(directory, ".env"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
};

const configEnvLines = async (): Promise<Array<string>> => {
  const contents = await readConfigEnv(join(requireConfigDirectory(), ".env"));
  const lines = contents === "" ? [] : contents.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

export const updateConfigEnv = async (name: string, value: string): Promise<void> => {
  // Bun's --env-file parser mangles these on read-back: # truncates as a comment,
  // $ expands (even quoted), quotes strip, and edge whitespace trims. Reject loudly
  // instead of storing a value that would round-trip corrupted; process env is the
  // documented escape hatch for such secrets.
  if (/[\r\n#$'"]/.test(value) || value !== value.trim()) {
    throw new Error(
      `${name} contains characters Bun cannot store in .env ('#', '$', quotes, edge whitespace, or newlines); set the environment variable directly instead.`,
    );
  }
  const lines = await configEnvLines();
  await writeConfigEnv(
    [...lines.filter((line) => configEnvName(line) !== name), `${name}=${value}`].join("\n") + "\n",
  );
};

export const removeConfigEnv = async (name: string): Promise<void> => {
  const lines = await configEnvLines();
  const kept = lines.filter((line) => configEnvName(line) !== name);
  if (kept.length === lines.length) return;
  await writeConfigEnv(kept.length === 0 ? "" : kept.join("\n") + "\n");
};
