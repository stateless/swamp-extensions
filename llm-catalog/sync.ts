/**
 * `sync` price-refresh for `@stateless/llm-catalog` — pulls a provider's live
 * pricing feed (OpenRouter `/api/v1/models`) and refreshes the `cost` facet of
 * declared gateway access-paths by matching their `api.providerModelId`.
 *
 * The binding (which model × which provider × which provider-model-id) is
 * curated in the catalog; only the volatile PRICE is synced — so `sync` never
 * guesses model↔provider mappings, it just keeps the numbers fresh and
 * `asOf`-stamped. Pure + deterministic for unit testing; the method wraps it
 * with the fetch + writeResource (into a separate `priced-path` resource so it
 * never collides with the curated baseline).
 *
 * @module
 */

export const OPENROUTER_FEED = "https://openrouter.ai/api/v1/models";

interface Price {
  inUsd: number;
  outUsd: number;
}

/** Round a per-token price up to per-MTok (USD), to 4 dp. */
function perMTok(perToken: unknown): number | undefined {
  const n = typeof perToken === "string"
    ? parseFloat(perToken)
    : Number(perToken);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Number((n * 1_000_000).toFixed(4));
}

/** Parse an OpenRouter `/models` payload into providerModelId → per-MTok price. */
export function parseOpenRouterFeed(payload: unknown): Map<string, Price> {
  const map = new Map<string, Price>();
  // deno-lint-ignore no-explicit-any
  const data = (payload as any)?.data;
  if (!Array.isArray(data)) return map;
  for (const m of data) {
    if (!m || typeof m.id !== "string" || !m.pricing) continue;
    const inUsd = perMTok(m.pricing.prompt);
    const outUsd = perMTok(m.pricing.completion);
    if (inUsd == null || outUsd == null) continue;
    map.set(m.id, { inUsd, outUsd });
  }
  return map;
}

/** A refreshed gateway price, one per (model × gateway runsOn entry). */
export interface PricedPath {
  id: string;
  model: string;
  endpoint: string;
  providerModelId: string;
  perMTokInUsd: number;
  perMTokOutUsd: number;
  provenance: { asOf: string; source: string; verification: string };
}

export interface RefreshResult {
  priced: PricedPath | null;
  /** true if a price was found and applied. */
  found: boolean;
  /** the providerModelId we looked up (for reporting). */
  providerModelId?: string;
}

/**
 * Refresh one model `runsOn[]` gateway entry's price from a feed. Gateway run-
 * options carry a `providerModelId` (the feed key) and a `cost` facet; only the
 * volatile PRICE is synced — `sync` never guesses model↔provider mappings, that
 * binding is curated. Returns `{found:false}` when the entry has no
 * providerModelId or it isn't in the feed (caller skips + reports).
 */
export function refreshGatewayCost(
  modelId: string,
  // deno-lint-ignore no-explicit-any
  ro: any,
  priceMap: Map<string, Price>,
  asOf: string,
  feedUrl: string,
): RefreshResult {
  const providerModelId: string | undefined = ro?.providerModelId;
  if (!providerModelId) return { priced: null, found: false };

  const price = priceMap.get(providerModelId);
  if (!price) return { priced: null, found: false, providerModelId };

  return {
    priced: {
      id: `${modelId}::${ro.endpoint}`,
      model: modelId,
      endpoint: ro.endpoint,
      providerModelId,
      perMTokInUsd: price.inUsd,
      perMTokOutUsd: price.outUsd,
      provenance: {
        asOf,
        source: feedUrl,
        verification: "authoritative", // authoritative AT asOf — price is volatile
      },
    },
    found: true,
    providerModelId,
  };
}
