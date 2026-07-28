import { afterAll, describe, expect, test } from "vitest";
import { setTimeout } from "node:timers/promises";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnRuntime } from "../support.js";
import { modifyCredential, readCredential } from "../../src/shared/credential-store.js";

const temporaryDirectories: Array<string> = [];
const marker = "synthetic-secret-marker";

const credential = (suffix: string) => ({
  type: "oauth" as const,
  access: `${marker}-access-${suffix}`,
  refresh: `${marker}-refresh-${suffix}`,
  expires: 1,
  accountId: `account-${suffix}`,
});

const directory = async () => {
  const value = await mkdtemp(join(tmpdir(), "mitome-store-"));
  temporaryDirectories.push(value);
  return value;
};

const write = (configDirectory: string, providerKey: string, value: unknown) =>
  modifyCredential(configDirectory, providerKey, () => [value, undefined]);

const remove = (configDirectory: string, providerKey: string) =>
  modifyCredential(configDirectory, providerKey, () => [undefined, undefined]);

const contents = async (configDirectory: string): Promise<unknown> =>
  JSON.parse(await readFile(join(configDirectory, "auth.json"), "utf8"));

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

describe("Credential storage", () => {
  test("scopes each transaction to one provider entry", async () => {
    const configDirectory = await directory();
    await write(configDirectory, "alpha", credential("alpha"));
    await write(configDirectory, "beta", credential("beta"));

    const seen = await modifyCredential(configDirectory, "alpha", (current) => [current, current]);
    expect(seen).toEqual(credential("alpha"));

    await write(configDirectory, "alpha", credential("alpha-2"));
    expect(await contents(configDirectory)).toEqual({
      alpha: credential("alpha-2"),
      beta: credential("beta"),
    });

    await remove(configDirectory, "alpha");
    expect(await contents(configDirectory)).toEqual({ beta: credential("beta") });
    expect(await readCredential(configDirectory, "alpha")).toBeUndefined();
  });

  test("reads absent storage as the pre-login state", async () => {
    expect(await readCredential(await directory(), "alpha")).toBeUndefined();
  });

  test("serializes atomic cross-process writes and keeps storage private", async () => {
    const configDirectory = await directory();
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      join(configDirectory, "auth.json"),
      JSON.stringify({ other: { retained: true } }),
    );
    const source = new URL("../../dist/shared/credential-store.js", import.meta.url).href;
    const writer = (providerKey: string) =>
      spawnRuntime([
        "-e",
        `const { modifyCredential } = await import(${JSON.stringify(source)}); await modifyCredential(${JSON.stringify(configDirectory)}, ${JSON.stringify(providerKey)}, () => [${JSON.stringify(credential(providerKey))}, undefined]);`,
      ]);
    const writers = [writer("first"), writer("second")];
    expect(await Promise.all(writers.map((child) => child.exited))).toEqual([0, 0]);
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        write(configDirectory, "concurrent", credential(String(index))),
      ),
    );
    expect(await contents(configDirectory)).toMatchObject({
      other: { retained: true },
      first: { type: "oauth" },
      second: { type: "oauth" },
      concurrent: { type: "oauth" },
    });
    expect((await stat(join(configDirectory, "auth.json"))).mode & 0o777).toBe(0o600);
  });

  test("does not reap a stale storage lock", async () => {
    const configDirectory = await directory();
    await mkdir(configDirectory, { recursive: true });
    const lock = join(configDirectory, "auth.lock");
    await writeFile(lock, "");
    const stale = new Date(Date.now() - 31_000);
    await utimes(lock, stale, stale);

    const pending = write(configDirectory, "alpha", credential("stale"));
    await setTimeout(50);
    expect(await readFile(lock, "utf8")).toBe("");

    await rm(lock);
    await pending;
    expect(await contents(configDirectory)).toMatchObject({ alpha: { type: "oauth" } });
  });

  test("names the file and the remedy for corrupted storage", async () => {
    const configDirectory = await directory();
    const path = join(configDirectory, "auth.json");
    await writeFile(path, "{ truncated");
    const corrupted = `Credential storage at ${path} is corrupted; delete it and authenticate again.`;
    await expect(readCredential(configDirectory, "alpha")).rejects.toThrow(corrupted);
    // Every write reads first, so a re-authentication attempt must report the same remedy.
    await expect(write(configDirectory, "alpha", credential("recovery"))).rejects.toThrow(
      corrupted,
    );

    await writeFile(path, JSON.stringify([1, 2]));
    await expect(readCredential(configDirectory, "alpha")).rejects.toThrow(corrupted);
  });
});
