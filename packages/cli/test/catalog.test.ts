import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { modelCatalog, type ModelCatalog } from "../src/catalog.ts";

const fallback: ModelCatalog = {
  openai: ["fallback-openai"],
  "openai-codex": ["fallback-codex"],
};
const payload = {
  openai: {
    models: {
      "gpt-5": { id: "gpt-5" },
      "gpt-5-codex": { id: "gpt-5-codex" },
    },
  },
};
const directories: Array<string> = [];

const directory = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "mitome-catalog-"));
  directories.push(path);
  return path;
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("models.dev catalog", () => {
  test("uses a fresh cache without fetching", async () => {
    const path = await directory();
    await writeFile(
      join(path, "models-cache.json"),
      JSON.stringify({ ...fallback, fetchedAt: 1_000 }),
    );
    const fetch = vi.fn();

    await expect(
      modelCatalog({ directory: path, fallback, fetch, now: () => 1_001 }),
    ).resolves.toEqual(fallback);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("refreshes an expired cache from models.dev", async () => {
    const path = await directory();
    await writeFile(join(path, "models-cache.json"), JSON.stringify({ ...fallback, fetchedAt: 0 }));
    const fetch = vi.fn(async () => new Response(JSON.stringify(payload)));

    await expect(
      modelCatalog({ directory: path, fallback, fetch, now: () => 24 * 60 * 60 * 1_000 }),
    ).resolves.toEqual({ openai: ["gpt-5", "gpt-5-codex"], "openai-codex": ["gpt-5-codex"] });
    expect(fetch).toHaveBeenCalledOnce();
  });

  test("uses stale cache when fetching fails", async () => {
    const path = await directory();
    await writeFile(join(path, "models-cache.json"), JSON.stringify({ ...fallback, fetchedAt: 0 }));

    await expect(
      modelCatalog({
        directory: path,
        fallback,
        fetch: async () => Promise.reject(new Error("offline")),
        now: () => 24 * 60 * 60 * 1_000,
      }),
    ).resolves.toEqual(fallback);
  });

  test("returns the fetched catalog even when the cache cannot be written", async () => {
    const path = await directory();
    const blocked = join(path, "occupied");
    // A file where the cache directory should be makes writeCache's mkdir fail.
    await writeFile(blocked, "");
    const fetch = vi.fn(async () => new Response(JSON.stringify(payload)));

    await expect(
      modelCatalog({ directory: join(blocked, "sub"), fallback, fetch }),
    ).resolves.toEqual({ openai: ["gpt-5", "gpt-5-codex"], "openai-codex": ["gpt-5-codex"] });
  });

  test("uses hardcoded hints when no cache and fetching fails", async () => {
    await expect(
      modelCatalog({
        directory: await directory(),
        fallback,
        fetch: async () => Promise.reject(new Error("offline")),
      }),
    ).resolves.toEqual(fallback);
  });
});
