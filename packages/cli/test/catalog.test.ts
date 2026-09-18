import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { modelCatalog, toolCapableOpenAiModels } from "../src/catalog.ts";

const fallback = ["fallback-openai"];
const payload = {
  openai: {
    models: {
      "gpt-5": { id: "gpt-5", tool_call: true },
      "gpt-5-codex": { id: "gpt-5-codex", tool_call: true },
      "gpt-image": { id: "gpt-image", tool_call: false },
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
  test("reads limit.context per tool-capable model and never guesses a missing one", () => {
    expect(
      toolCapableOpenAiModels({
        openai: {
          models: {
            windowed: { id: "windowed", tool_call: true, limit: { context: 128_000, output: 1 } },
            unlimited: { id: "unlimited", tool_call: true },
            malformed: { id: "malformed", tool_call: true, limit: { context: "128k" } },
            noTools: { id: "no-tools", tool_call: false, limit: { context: 8_192 } },
          },
        },
      }),
    ).toEqual([
      { id: "windowed", contextWindow: 128_000 },
      { id: "unlimited", contextWindow: undefined },
      { id: "malformed", contextWindow: undefined },
    ]);
  });

  test("uses a fresh cache without fetching", async () => {
    const path = await directory();
    await writeFile(
      join(path, "models-cache.json"),
      JSON.stringify({ openai: fallback, fetchedAt: 1_000 }),
    );
    const fetch = vi.fn();

    await expect(
      modelCatalog({ directory: path, fallback, fetch, now: () => 1_001 }),
    ).resolves.toEqual(fallback);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("treats a cache with one malformed entry as a miss", async () => {
    const path = await directory();
    await writeFile(
      join(path, "models-cache.json"),
      JSON.stringify({ openai: ["cached", 1], fetchedAt: 1_000 }),
    );
    const fetch = vi.fn(async () => new Response(JSON.stringify(payload)));

    await expect(
      modelCatalog({ directory: path, fallback, fetch, now: () => 1_001 }),
    ).resolves.toEqual(["gpt-5", "gpt-5-codex"]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  test("refreshes an expired cache with tool-capable models from models.dev", async () => {
    const path = await directory();
    await writeFile(
      join(path, "models-cache.json"),
      JSON.stringify({ openai: fallback, fetchedAt: 0 }),
    );
    const fetch = vi.fn(async () => new Response(JSON.stringify(payload)));

    await expect(
      modelCatalog({ directory: path, fallback, fetch, now: () => 24 * 60 * 60 * 1_000 }),
    ).resolves.toEqual(["gpt-5", "gpt-5-codex"]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  test("filters malformed models without rejecting the models.dev response", async () => {
    const path = await directory();
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            openai: {
              models: {
                valid: { id: "valid", tool_call: true },
                missingId: { tool_call: true },
                wrongCapability: { id: "wrong", tool_call: "yes" },
              },
            },
          }),
        ),
    );

    await expect(modelCatalog({ directory: path, fallback, fetch })).resolves.toEqual(["valid"]);
  });

  test("uses stale cache when fetching fails", async () => {
    const path = await directory();
    await writeFile(
      join(path, "models-cache.json"),
      JSON.stringify({ openai: fallback, fetchedAt: 0 }),
    );

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
    ).resolves.toEqual(["gpt-5", "gpt-5-codex"]);
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
