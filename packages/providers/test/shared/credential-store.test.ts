import { afterAll, describe, expect, test } from "vite-plus/test";
import { it } from "@effect/vitest";
import { Effect, Fiber, FileSystem, PlatformError, Schema } from "effect";
import { TestClock } from "effect/testing";
import { setTimeout } from "node:timers/promises";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnRuntime } from "../support.js";
import { modifyCredential, readCredential } from "../../src/shared/credential-store.js";
import { platformLayer } from "../../src/shared/platform.js";

type StoredCredential = Schema.Json;

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

const writeEffect = (stateDirectory: string, providerKey: string, value: StoredCredential) =>
  modifyCredential(stateDirectory, providerKey, () => Effect.succeed([value, undefined])).pipe(
    Effect.provide(platformLayer),
  );

const write = (stateDirectory: string, providerKey: string, value: StoredCredential) =>
  Effect.runPromise(writeEffect(stateDirectory, providerKey, value));

const remove = (stateDirectory: string, providerKey: string) =>
  Effect.runPromise(
    modifyCredential(stateDirectory, providerKey, () =>
      Effect.succeed([undefined, undefined]),
    ).pipe(Effect.provide(platformLayer)),
  );

const contents = async (stateDirectory: string): Promise<StoredCredential> =>
  Schema.decodeSync(Schema.fromJsonString(Schema.Json))(
    await readFile(join(stateDirectory, "auth.json"), "utf8"),
  );

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

describe("Credential storage", () => {
  test("scopes each transaction to one provider entry", async () => {
    const stateDirectory = await directory();
    await write(stateDirectory, "alpha", credential("alpha"));
    await write(stateDirectory, "beta", credential("beta"));

    const seen = await Effect.runPromise(
      modifyCredential(stateDirectory, "alpha", (current) =>
        Effect.succeed([current, current]),
      ).pipe(Effect.provide(platformLayer)),
    );
    expect(seen).toEqual(credential("alpha"));

    await write(stateDirectory, "alpha", credential("alpha-2"));
    expect(await contents(stateDirectory)).toEqual({
      alpha: credential("alpha-2"),
      beta: credential("beta"),
    });

    await remove(stateDirectory, "alpha");
    expect(await contents(stateDirectory)).toEqual({ beta: credential("beta") });
    expect(
      await Effect.runPromise(
        readCredential(stateDirectory, "alpha").pipe(Effect.provide(platformLayer)),
      ),
    ).toBeUndefined();
  });

  test("reads absent storage as the pre-login state", async () => {
    expect(
      await Effect.runPromise(
        readCredential(await directory(), "alpha").pipe(Effect.provide(platformLayer)),
      ),
    ).toBeUndefined();
  });

  test.skipIf(process.platform === "win32")(
    "makes a state directory it creates private and leaves an existing one's mode",
    async () => {
      const existing = await directory();
      await chmod(existing, 0o755);
      await write(existing, "alpha", credential("alpha"));
      expect((await stat(existing)).mode & 0o777).toBe(0o755);
      expect((await stat(join(existing, "auth.json"))).mode & 0o777).toBe(0o600);

      const created = join(await directory(), "state");
      await write(created, "alpha", credential("alpha"));
      expect((await stat(created)).mode & 0o777).toBe(0o700);
    },
  );

  test(
    "serializes atomic cross-process writes and keeps storage private",
    { tags: ["dist"] },
    async () => {
      const stateDirectory = await directory();
      await mkdir(stateDirectory, { recursive: true });
      await writeFile(
        join(stateDirectory, "auth.json"),
        JSON.stringify({ other: { retained: true } }),
      );
      const source = new URL("../../dist/shared/credential-store.js", import.meta.url).href;
      const platform = new URL("../../dist/shared/platform.js", import.meta.url).href;
      const writer = (providerKey: string) =>
        spawnRuntime([
          "-e",
          `import { Effect } from "effect"; const { modifyCredential } = await import(${JSON.stringify(source)}); const { platformLayer } = await import(${JSON.stringify(platform)}); await Effect.runPromise(modifyCredential(${JSON.stringify(stateDirectory)}, ${JSON.stringify(providerKey)}, () => Effect.succeed([${JSON.stringify(credential(providerKey))}, undefined])).pipe(Effect.provide(platformLayer)));`,
        ]);
      const writers = [writer("first"), writer("second")];
      expect(await Promise.all(writers.map((child) => child.exited))).toEqual([0, 0]);
      await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          write(stateDirectory, "concurrent", credential(String(index))),
        ),
      );
      expect(await contents(stateDirectory)).toMatchObject({
        other: { retained: true },
        first: { type: "oauth" },
        second: { type: "oauth" },
        concurrent: { type: "oauth" },
      });
    },
  );

  // A umask applies only to POSIX modes, and only a process of its own can change it.
  test.skipIf(process.platform === "win32")(
    "writes storage readable and writable by its owner alone under any umask, replacing a wider file",
    { tags: ["dist"] },
    async () => {
      const stateDirectory = await directory();
      await mkdir(stateDirectory, { recursive: true });
      const path = join(stateDirectory, "auth.json");
      await writeFile(path, JSON.stringify({ other: { retained: true } }), { mode: 0o644 });
      const source = new URL("../../dist/shared/credential-store.js", import.meta.url).href;
      const platform = new URL("../../dist/shared/platform.js", import.meta.url).href;
      // The mask takes the owner's read permission away from every file the process creates.
      const writer = spawnRuntime([
        "-e",
        `process.umask(0o477); import { Effect } from "effect"; const { modifyCredential } = await import(${JSON.stringify(source)}); const { platformLayer } = await import(${JSON.stringify(platform)}); for (const key of ["first", "second"]) await Effect.runPromise(modifyCredential(${JSON.stringify(stateDirectory)}, key, () => Effect.succeed([{ type: "oauth" }, undefined])).pipe(Effect.provide(platformLayer)));`,
      ]);
      expect(await writer.exited).toBe(0);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await contents(stateDirectory)).toMatchObject({
        other: { retained: true },
        first: { type: "oauth" },
        second: { type: "oauth" },
      });
    },
  );

  it.effect("times out a contended storage lock on the Effect Clock", () =>
    Effect.gen(function* () {
      const stateDirectory = yield* Effect.promise(directory);
      yield* Effect.promise(() => mkdir(stateDirectory, { recursive: true }));
      const lock = join(stateDirectory, "auth.lock");
      yield* Effect.promise(() => writeFile(lock, ""));

      const fiber = yield* Effect.forkChild(
        Effect.flip(writeEffect(stateDirectory, "alpha", credential("timeout"))),
        { startImmediately: true },
      );
      // Let each real filesystem rejection register its next Clock-driven retry.
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            globalThis.setTimeout(resolve, 25);
          }),
      );
      for (let seconds = 0; seconds < 31; seconds += 1) {
        yield* TestClock.adjust("1 second");
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              setImmediate(resolve);
            }),
        );
      }
      expect((yield* Fiber.join(fiber)).message).toBe(
        `Credential storage lock timed out: ${lock}. If no other process is authenticating, delete ${lock} and retry.`,
      );
    }),
  );

  it.live("releases the storage lock when an update is interrupted", () =>
    Effect.gen(function* () {
      const stateDirectory = yield* Effect.promise(directory);
      const path = join(stateDirectory, "auth.lock");
      const fiber = yield* Effect.forkChild(
        modifyCredential(stateDirectory, "alpha", () => Effect.interruptible(Effect.never)).pipe(
          Effect.provide(platformLayer),
        ),
        { startImmediately: true },
      );
      yield* Effect.promise(async () => {
        while (true) {
          try {
            await readFile(path);
            return;
          } catch {
            await setTimeout(1);
          }
        }
      });

      yield* Fiber.interrupt(fiber);
      yield* Effect.promise(async () => {
        await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
      });
    }),
  );

  test("does not reap a stale storage lock", async () => {
    const stateDirectory = await directory();
    await mkdir(stateDirectory, { recursive: true });
    const lock = join(stateDirectory, "auth.lock");
    await writeFile(lock, "");
    const stale = new Date(Date.now() - 31_000);
    await utimes(lock, stale, stale);

    const pending = write(stateDirectory, "alpha", credential("stale"));
    await setTimeout(50);
    expect(await readFile(lock, "utf8")).toBe("");

    await rm(lock);
    await pending;
    expect(await contents(stateDirectory)).toMatchObject({ alpha: { type: "oauth" } });
  });

  test("keeps the stored file and removes the temporary copy when syncing it fails", async () => {
    const stateDirectory = await directory();
    const stored = JSON.stringify({ alpha: credential("before") });
    await writeFile(join(stateDirectory, "auth.json"), stored);
    // A rejection need not be an Error; each still fails as a storage error that keeps it.
    const rejections: ReadonlyArray<readonly [unknown, string]> = [
      [new Error("sync failed"), "sync failed"],
      [{ message: "sync failed", code: 5 }, "sync failed"],
      ["sync failed", "Credential storage failed"],
    ];
    for (const [rejection, message] of rejections) {
      // The platform, but syncing a file fails with `rejection` as what the system reported.
      const failed = PlatformError.systemError({
        _tag: "Unknown",
        module: "FileSystem",
        method: "sync",
        cause: rejection,
      });
      const failingSync = Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* modifyCredential(stateDirectory, "alpha", () =>
          Effect.succeed([credential("alpha"), undefined]),
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            open: (path, options) =>
              Effect.map(fs.open(path, options), (file) =>
                Object.defineProperty(file, "sync", { value: Effect.fail(failed) }),
              ),
          }),
        );
      });
      await expect(
        Effect.runPromise(failingSync.pipe(Effect.provide(platformLayer))),
      ).rejects.toMatchObject({
        _tag: "CredentialStoreError",
        message,
        cause: rejection,
      });
      expect(await readdir(stateDirectory)).toEqual(["auth.json"]);
      expect(await readFile(join(stateDirectory, "auth.json"), "utf8")).toBe(stored);
    }
  });

  test("reports a staged file that cannot be closed as a storage error, keeping the stored file", async () => {
    const stateDirectory = await directory();
    const stored = JSON.stringify({ alpha: credential("before") });
    await writeFile(join(stateDirectory, "auth.json"), stored);
    const failed = PlatformError.systemError({
      _tag: "Unknown",
      module: "FileSystem",
      method: "close",
      cause: new Error("close failed"),
    });
    // The platform, but closing the staged file fails, as a defect, which is how it closes one.
    const failingClose = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* modifyCredential(stateDirectory, "alpha", () =>
        Effect.succeed([credential("alpha"), undefined]),
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          open: (path, options) =>
            path.endsWith("auth.lock")
              ? fs.open(path, options)
              : Effect.tap(fs.open(path, options), () =>
                  Effect.addFinalizer(() => Effect.die(failed)),
                ),
        }),
      );
    });
    await expect(
      Effect.runPromise(failingClose.pipe(Effect.provide(platformLayer))),
    ).rejects.toMatchObject({ _tag: "CredentialStoreError", message: "close failed" });
    expect(await readdir(stateDirectory)).toEqual(["auth.json"]);
    expect(await readFile(join(stateDirectory, "auth.json"), "utf8")).toBe(stored);
  });

  test.skipIf(process.platform === "win32")(
    "leaves the mode of a state directory another process creates first",
    async () => {
      const stateDirectory = join(await directory(), "state");
      // The platform, but another process makes the directory just before this one would.
      const racing = Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* modifyCredential(stateDirectory, "alpha", () =>
          Effect.succeed([credential("alpha"), undefined]),
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            makeDirectory: (path, options) =>
              Effect.andThen(
                Effect.promise(async () => {
                  // Its mode set outright: `mkdir` narrows the one it is given by the umask.
                  if ((await mkdir(stateDirectory, { recursive: true })) !== undefined) {
                    await chmod(stateDirectory, 0o755);
                  }
                }),
                fs.makeDirectory(path, options),
              ),
          }),
        );
      });
      await Effect.runPromise(racing.pipe(Effect.provide(platformLayer)));
      expect((await stat(stateDirectory)).mode & 0o777).toBe(0o755);
    },
  );

  test("names the file and the remedy for corrupted storage", async () => {
    const stateDirectory = await directory();
    const path = join(stateDirectory, "auth.json");
    await writeFile(path, "{ truncated");
    const corrupted = `Credential storage at ${path} is corrupted; delete it and authenticate again.`;
    await expect(
      Effect.runPromise(
        readCredential(stateDirectory, "alpha").pipe(Effect.provide(platformLayer)),
      ),
    ).rejects.toThrow(corrupted);
    // Every write reads first, so a re-authentication attempt must report the same remedy.
    await expect(write(stateDirectory, "alpha", credential("recovery"))).rejects.toThrow(corrupted);

    await writeFile(path, JSON.stringify([1, 2]));
    await expect(
      Effect.runPromise(
        readCredential(stateDirectory, "alpha").pipe(Effect.provide(platformLayer)),
      ),
    ).rejects.toThrow(corrupted);
  });
});
