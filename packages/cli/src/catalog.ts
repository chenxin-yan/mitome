import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const catalogUrl = "https://models.dev/api.json";
const cacheName = "models-cache.json";
const cacheTtl = 24 * 60 * 60 * 1000;
const fetchTimeout = 3_000;

export interface ModelCatalog {
  readonly openai: ReadonlyArray<string>;
  readonly "openai-codex": ReadonlyArray<string>;
}

interface CachedCatalog extends ModelCatalog {
  readonly fetchedAt: number;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface CatalogOptions {
  readonly directory: string;
  readonly fallback: ModelCatalog;
  readonly fetch?: Fetch;
  readonly now?: () => number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const modelIds = (value: unknown): Array<string> =>
  isRecord(value)
    ? Object.values(value).flatMap((model) =>
        isRecord(model) && typeof model.id === "string" && model.id !== "" ? [model.id] : [],
      )
    : [];

const catalogFromPayload = (payload: unknown): ModelCatalog | undefined => {
  // models.dev has one `openai` provider record for API models. It has no separate
  // ChatGPT/Codex provider record, so Codex hints are the OpenAI IDs containing `codex`.
  const openai = isRecord(payload)
    ? modelIds(isRecord(payload.openai) ? payload.openai.models : undefined)
    : [];
  const codex = openai.filter((id) => /codex/i.test(id));
  return openai.length > 0 && codex.length > 0 ? { openai, "openai-codex": codex } : undefined;
};

const strings = (value: unknown): Array<string> =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item !== "")
    : [];

const cachedCatalog = (value: unknown): CachedCatalog | undefined => {
  if (!isRecord(value) || typeof value.fetchedAt !== "number") return undefined;
  const openai = strings(value.openai);
  const codex = strings(value["openai-codex"]);
  return openai.length > 0 && codex.length > 0
    ? { openai, "openai-codex": codex, fetchedAt: value.fetchedAt }
    : undefined;
};

const readCache = async (path: string): Promise<CachedCatalog | undefined> => {
  try {
    return cachedCatalog(JSON.parse(await readFile(path, "utf8")));
  } catch {
    // Cache data is optional; a missing or malformed cache is an ordinary catalog miss.
    return undefined;
  }
};

const writeCache = async (path: string, catalog: CachedCatalog): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(catalog)}\n`);
};

export const modelCatalog = async ({
  directory,
  fallback,
  fetch: fetcher = fetch,
  now = Date.now,
}: CatalogOptions): Promise<ModelCatalog> => {
  const path = join(directory, cacheName);
  const cached = await readCache(path);
  if (cached !== undefined && now() - cached.fetchedAt < cacheTtl) {
    return { openai: cached.openai, "openai-codex": cached["openai-codex"] };
  }

  try {
    const response = await fetcher(catalogUrl, { signal: AbortSignal.timeout(fetchTimeout) });
    if (!response.ok) throw new Error(`models.dev returned ${response.status}`);
    const catalog = catalogFromPayload(await response.json());
    if (catalog === undefined) throw new Error("models.dev returned no OpenAI Codex models");
    // An unwritable cache (e.g. read-only config dir) must not discard the fetched catalog.
    await writeCache(path, { ...catalog, fetchedAt: now() }).catch(() => {});
    return catalog;
  } catch {
    return cached === undefined
      ? fallback
      : { openai: cached.openai, "openai-codex": cached["openai-codex"] };
  }
};
