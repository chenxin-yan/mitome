import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const catalogUrl = "https://models.dev/api.json";
const cacheName = "models-cache.json";
const cacheTtl = 24 * 60 * 60 * 1000;
const fetchTimeout = 3_000;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface CatalogOptions {
  readonly directory: string;
  readonly fallback: ReadonlyArray<string>;
  readonly fetch?: Fetch;
  readonly now?: () => number;
}

interface CachedCatalog {
  readonly openai: ReadonlyArray<string>;
  readonly fetchedAt: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

// models.dev describes the OpenAI API only; Codex suggestions come from the
// hand-maintained list in @mitome/providers/openai-codex (ADR-0028). The
// tool-capable filter matches the generated hint lists' rule.
const catalogFromPayload = (payload: unknown): ReadonlyArray<string> | undefined => {
  const models = isRecord(payload) && isRecord(payload.openai) ? payload.openai.models : undefined;
  const openai = isRecord(models)
    ? Object.values(models).flatMap((model) =>
        isRecord(model) &&
        typeof model.id === "string" &&
        model.id !== "" &&
        model.tool_call === true
          ? [model.id]
          : [],
      )
    : [];
  return openai.length > 0 ? openai : undefined;
};

const strings = (value: unknown): Array<string> =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item !== "")
    : [];

const cachedCatalog = (value: unknown): CachedCatalog | undefined => {
  if (!isRecord(value) || typeof value.fetchedAt !== "number") return undefined;
  const openai = strings(value.openai);
  return openai.length > 0 ? { openai, fetchedAt: value.fetchedAt } : undefined;
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
}: CatalogOptions): Promise<ReadonlyArray<string>> => {
  const path = join(directory, cacheName);
  const cached = await readCache(path);
  if (cached !== undefined && now() - cached.fetchedAt < cacheTtl) {
    return cached.openai;
  }

  try {
    const response = await fetcher(catalogUrl, { signal: AbortSignal.timeout(fetchTimeout) });
    if (!response.ok) throw new Error(`models.dev returned ${response.status}`);
    const catalog = catalogFromPayload(await response.json());
    if (catalog === undefined) throw new Error("models.dev returned no OpenAI models");
    // An unwritable cache (e.g. read-only config dir) must not discard the fetched catalog.
    await writeCache(path, { openai: catalog, fetchedAt: now() }).catch(() => {});
    return catalog;
  } catch {
    return cached === undefined ? fallback : cached.openai;
  }
};
