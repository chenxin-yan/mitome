import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "@effect/vitest";
import { Effect, type Scope } from "effect";
import { fileRoutes, memoryRoutes, StoreError, type RouteKey, type Routes } from "../src/index.js";

const key: RouteKey = { channel: "telegram", principal: "user-1", conversation: "chat-1" };

const withDirectory = <A, E>(
  use: (directory: string) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "mitome-routes-"))),
    use,
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  );

const behavesLikeRoutes = (routes: () => Effect.Effect<Routes, never, Scope.Scope>) => {
  it.effect("returns undefined for an unknown conversation", () =>
    Effect.gen(function* () {
      const store = yield* routes();
      expect(yield* store.get(key)).toBeUndefined();
    }),
  );

  it.effect("advances and clears one conversation without touching its neighbours", () =>
    Effect.gen(function* () {
      const store = yield* routes();
      const sibling = { ...key, conversation: "chat-2" };
      yield* store.set(key, "transcript-1");
      yield* store.set(sibling, "transcript-2");
      expect(yield* store.get(key)).toBe("transcript-1");

      yield* store.set(key, "transcript-3");
      expect(yield* store.get(key)).toBe("transcript-3");

      yield* store.clear(key);
      yield* store.clear(key);
      expect(yield* store.get(key)).toBeUndefined();
      expect(yield* store.get(sibling)).toBe("transcript-2");
    }),
  );

  it.effect("keys on every part of the conversation identity", () =>
    Effect.gen(function* () {
      const store = yield* routes();
      yield* store.set(key, "transcript-1");
      expect(yield* store.get({ ...key, channel: "slack" })).toBeUndefined();
      expect(yield* store.get({ ...key, principal: "user-2" })).toBeUndefined();
      // Swapping fields must not collide even though the joined text would.
      expect(
        yield* store.get({ ...key, principal: key.conversation, conversation: key.principal }),
      ).toBeUndefined();
    }),
  );
};

describe("memoryRoutes", () => {
  behavesLikeRoutes(() => Effect.sync(memoryRoutes));
});

describe("fileRoutes", () => {
  it("fails loudly without an explicit directory or resolvable config directory", () => {
    for (const name of ["MITOME_HOME", "XDG_CONFIG_HOME", "APPDATA", "HOME"]) {
      vi.stubEnv(name, "");
    }
    try {
      expect(() => fileRoutes()).toThrow(
        "Set MITOME_HOME, XDG_CONFIG_HOME, APPDATA (on Windows), or HOME.",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  behavesLikeRoutes(() =>
    Effect.map(
      Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "mitome-routes-"))),
        (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
      ),
      fileRoutes,
    ),
  );

  it.effect("survives a restart and keeps long keys within file name limits", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        const long = {
          channel: "c".repeat(120),
          principal: "p".repeat(120),
          conversation: "v".repeat(120),
        };
        yield* fileRoutes(directory).set(key, "transcript-1");
        yield* fileRoutes(directory).set(long, "transcript-long");

        const reopened = fileRoutes(directory);
        expect(yield* reopened.get(key)).toBe("transcript-1");
        expect(yield* reopened.get(long)).toBe("transcript-long");

        const files = yield* Effect.promise(() => readdir(directory));
        expect(files).toHaveLength(2);
        expect(files.every((name) => name.endsWith(".route.json") && name.length < 255)).toBe(true);
      }),
    ),
  );

  it.effect("rejects a file whose key does not match its name or shape", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        const store = fileRoutes(directory);
        yield* store.set(key, "transcript-1");
        const [file] = yield* Effect.promise(() => readdir(directory));
        const path = join(directory, file!);
        const stored = JSON.parse(yield* Effect.promise(() => readFile(path, "utf8")));

        yield* Effect.promise(() =>
          writeFile(path, JSON.stringify({ ...stored, conversation: "other" })),
        );
        expect(yield* Effect.flip(store.get(key))).toBeInstanceOf(StoreError);

        yield* Effect.promise(() => writeFile(path, "not json"));
        expect(yield* Effect.flip(store.get(key))).toBeInstanceOf(StoreError);
      }),
    ),
  );
});
