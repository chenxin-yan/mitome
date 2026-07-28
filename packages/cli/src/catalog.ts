import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Result, Schema } from "effect";

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

const NonEmptyString = Schema.String.check(Schema.isNonEmpty());
const CachedCatalogFromJson = Schema.fromJsonString(
  Schema.Struct({
    openai: Schema.NonEmptyArray(NonEmptyString),
    fetchedAt: Schema.Finite,
  }),
);
const ModelsDevEnvelope = Schema.Struct({
  openai: Schema.Struct({ models: Schema.Record(Schema.String, Schema.Unknown) }),
});
const ModelsDevModel = Schema.Struct({ id: NonEmptyString, tool_call: Schema.Boolean });

// models.dev describes the OpenAI API only; Codex suggestions come from the
// hand-maintained list in @mitome/providers/openai-codex (ADR-0028). This is
// the one tool-capable filter; scripts/generate-model-hints.ts imports it.
export const toolCapableOpenAiIds = (payload: unknown): Array<string> => {
  const envelope = Schema.decodeUnknownResult(ModelsDevEnvelope)(payload);
  if (Result.isFailure(envelope)) return [];
  return Object.values(envelope.success.openai.models).flatMap((model) => {
    const decoded = Schema.decodeUnknownResult(ModelsDevModel)(model);
    return Result.isSuccess(decoded) && decoded.success.tool_call ? [decoded.success.id] : [];
  });
};

const readCache = async (path: string): Promise<CachedCatalog | undefined> => {
  try {
    const decoded = Schema.decodeUnknownResult(CachedCatalogFromJson, {
      onExcessProperty: "error",
    })(await readFile(path, "utf8"));
    return Result.isSuccess(decoded) ? decoded.success : undefined;
  } catch {
    // Cache data is optional; a missing cache is an ordinary catalog miss.
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
    const catalog = toolCapableOpenAiIds(await response.json());
    if (catalog.length === 0) throw new Error("models.dev returned no OpenAI models");
    // An unwritable cache (e.g. read-only config dir) must not discard the fetched catalog.
    await writeCache(path, { openai: catalog, fetchedAt: now() }).catch(() => {});
    return catalog;
  } catch {
    // Catalog is optional: fetch abort/timeout, non-2xx responses, JSON parse failures, and models.dev schema drift all fall back to stale cache, then static hints.
    return cached === undefined ? fallback : cached.openai;
  }
};
