/**
 * Domain layer: turns raw CMC responses into the shapes the app works with.
 *
 * Endpoints used here:
 *   GET /v5/real-world-assets/assets/list         - RWA universe ranked by tokenized market cap
 *   GET /v5/real-world-assets/quotes/latest       - per-asset quotes + the tokens that track each asset
 *   GET /v5/real-world-assets/quotes/historical   - tokenized price / mcap / volume history
 *   GET /v5/real-world-assets/market-pairs/list   - where a tokenized asset trades
 *   GET /v5/real-world-assets/issuers/list        - issuer directory
 *   GET /v5/real-world-assets/issuers             - one issuer's tokens
 *   GET /v5/real-world-assets/info                - asset metadata
 *   GET /v2/cryptocurrency/quotes/latest          - token-level momentum (1h/24h/7d/30d change)
 *   GET /v1/global-metrics/quotes/latest          - total crypto market cap for the RWA share
 *   GET /v1/key/info                              - credit usage
 */
import { CmcError, cmcGet, TTL } from "./cmc.ts";

export type AssetType = "stock" | "commodity" | "currency" | "government_security" | "etf" | "real_estate";

interface RawQuote {
  symbol?: string;
  average_tokenized_price?: number;
  tokenized_market_cap?: number;
  tokenized_volume_24h?: number;
  last_updated?: string;
}
interface RawAsset extends RawQuote {
  name: string;
  symbol: string;
  slug: string;
  rwa_id: number;
  asset_type: AssetType;
  rwa_rank: number;
  has_tokens: boolean;
  quotes?: RawQuote[];
  tokens?: {
    symbol: string; name: string; price: number; crypto_id: number;
    issuer_id: string | null; issuer_name: string | null; market_cap: number | null; volume_24h: number | null;
  }[];
  tradfi_markets?: { exchange: { slug: string; name: string; exchange_id: number }; ticker: string; market_url: string | null }[];
}

export interface RwaAsset {
  rwaId: number;
  name: string;
  symbol: string;
  slug: string;
  assetType: AssetType;
  rank: number;
  avgPrice: number | null;
  mcap: number;
  vol24h: number;
  lastUpdated: string | null;
  tradfi: { exchange: string; ticker: string }[];
}

export interface RwaToken {
  cryptoId: number;
  symbol: string;
  name: string;
  price: number;
  mcap: number;
  vol24h: number;
  issuerId: string | null;
  issuerName: string | null;
  rwaId: number;
  assetName: string;
  assetSymbol: string;
  assetType: AssetType;
  /** asset's average tokenized price - the reference used for premium/discount */
  assetAvgPrice: number | null;
  change1h: number | null;
  change24h: number | null;
  change7d: number | null;
  change30d: number | null;
}

/** USD quote: prefer the top-level fields, fall back to quotes[USD]. */
function usd(a: RawQuote & { quotes?: RawQuote[] }) {
  const q = a.quotes?.find((x) => x.symbol === "USD") ?? a.quotes?.[0] ?? {};
  return {
    avgPrice: a.average_tokenized_price ?? q.average_tokenized_price ?? null,
    mcap: a.tokenized_market_cap ?? q.tokenized_market_cap ?? 0,
    vol24h: a.tokenized_volume_24h ?? q.tokenized_volume_24h ?? 0,
    lastUpdated: a.last_updated ?? q.last_updated ?? null,
  };
}

function toAsset(a: RawAsset): RwaAsset {
  return {
    rwaId: a.rwa_id,
    name: a.name,
    symbol: a.symbol,
    slug: a.slug,
    assetType: a.asset_type,
    rank: a.rwa_rank,
    ...usd(a),
    tradfi: (a.tradfi_markets ?? []).map((m) => ({ exchange: m.exchange?.name, ticker: m.ticker })),
  };
}

export async function listAssets(opts: { assetType?: AssetType; limit?: number; sort?: string } = {}) {
  const res = await cmcGet<{ rwa_assets: RawAsset[]; total_size: number }>("/v5/real-world-assets/assets/list", {
    asset_type: opts.assetType,
    sort: opts.sort ?? "tokenized_market_cap",
    sort_dir: "desc",
    limit: opts.limit ?? 100,
  });
  // live data contains rows with a null rwa_id; they can't be queried further, so drop them
  return { assets: (res.data.rwa_assets ?? []).filter((a) => a.rwa_id != null).map(toAsset), total: res.data.total_size };
}

export async function assetQuotes(rwaIds: number[]) {
  if (!rwaIds.length) return [];
  const res = await cmcGet<{ rwa_assets: RawAsset[] }>("/v5/real-world-assets/quotes/latest", {
    rwa_id: rwaIds.join(","),
    skip_invalid: "true",
  });
  return res.data.rwa_assets ?? [];
}

interface CryptoQuote {
  id: number;
  symbol: string;
  quote: { USD: { price: number; volume_24h: number; percent_change_1h: number; percent_change_24h: number; percent_change_7d: number; percent_change_30d?: number; market_cap: number } };
}

export async function cryptoQuotes(ids: number[]): Promise<Map<number, CryptoQuote>> {
  const out = new Map<number, CryptoQuote>();
  const unique = [...new Set(ids)].filter(Boolean);
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    try {
      const res = await cmcGet<Record<string, CryptoQuote | CryptoQuote[]>>("/v2/cryptocurrency/quotes/latest", { id: chunk.join(","), skip_invalid: "true" });
      for (const [k, v] of Object.entries(res.data ?? {})) {
        const q = Array.isArray(v) ? v[0] : v;
        if (q?.quote?.USD) out.set(Number(k), q);
      }
    } catch (err) {
      // Momentum is an enrichment; the screener still works without it.
      console.warn("[rwa] crypto quotes failed:", (err as Error).message);
    }
  }
  return out;
}

/**
 * The tradable universe: every token that tracks one of the top RWA assets,
 * enriched with token-level momentum from the classic crypto quotes endpoint.
 */
export async function tokenUniverse(opts: { assetType?: AssetType; limit?: number } = {}) {
  const { assets } = await listAssets({ assetType: opts.assetType, limit: opts.limit ?? 60 });
  const withTokens = assets.filter((a) => a.mcap > 0);
  const raw = await assetQuotes(withTokens.map((a) => a.rwaId));
  const assetById = new Map(raw.map((r) => [r.rwa_id, r]));

  const tokens: RwaToken[] = [];
  for (const r of raw) {
    const a = toAsset(r);
    for (const tk of r.tokens ?? []) {
      // Skip placeholder rows (null symbol/price) and dead listings with no cap and no volume
      // (live data includes "Derivatives" reference rows and delisted wrappers).
      if (!tk.crypto_id || !tk.symbol || !tk.price) continue;
      if (!(tk.market_cap ?? 0) && !(tk.volume_24h ?? 0)) continue;
      tokens.push({
        cryptoId: tk.crypto_id,
        symbol: tk.symbol,
        name: tk.name,
        price: tk.price,
        mcap: tk.market_cap ?? 0,
        vol24h: tk.volume_24h ?? 0,
        issuerId: tk.issuer_id,
        issuerName: tk.issuer_name,
        rwaId: a.rwaId,
        assetName: a.name,
        assetSymbol: a.symbol,
        assetType: a.assetType,
        assetAvgPrice: a.avgPrice,
        change1h: null,
        change24h: null,
        change7d: null,
        change30d: null,
      });
    }
  }

  const quotes = await cryptoQuotes(tokens.map((t) => t.cryptoId));
  for (const t of tokens) {
    const q = quotes.get(t.cryptoId)?.quote.USD;
    if (!q) continue;
    t.change1h = q.percent_change_1h ?? null;
    t.change24h = q.percent_change_24h ?? null;
    t.change7d = q.percent_change_7d ?? null;
    t.change30d = q.percent_change_30d ?? null;
    // crypto quotes refresh more often than RWA aggregates; prefer them when present
    if (q.price) t.price = q.price;
    if (q.volume_24h) t.vol24h = q.volume_24h;
  }

  return { assets: [...assetById.values()].map(toAsset), tokens };
}

export async function assetHistory(rwaId: number, interval = "daily", count = 90) {
  const res = await cmcGet<{ rwa_assets: (Omit<RawAsset, "quotes"> & { quotes: { timestamp: string; average_tokenized_price: number; tokenized_market_cap: number; tokenized_volume_24h: number }[] })[] }>(
    "/v5/real-world-assets/quotes/historical",
    { rwa_id: rwaId, interval, count },
    { ttlMs: TTL.medium },
  );
  const a = res.data.rwa_assets?.[0];
  return (a?.quotes ?? []).map((q) => ({ t: q.timestamp, price: q.average_tokenized_price, mcap: q.tokenized_market_cap, vol: q.tokenized_volume_24h }));
}

/**
 * Some plans don't include market pairs (live: HTTP 403, error_code 1006 on our
 * 15k-credit plan, though the docs list every plan). Remember that and stop asking.
 */
let pairsUnsupported: string | null = null;
export const marketPairsUnsupported = () => pairsUnsupported;

export async function marketPairs(rwaId: number) {
  if (pairsUnsupported) throw new CmcError(pairsUnsupported, 403, "1006", "/v5/real-world-assets/market-pairs/list");
  const res = await cmcGet<{ num_market_pairs: number; market_pairs: {
    exchange: { name: string }; market_pair: string; category: string;
    market_pair_base: { symbol: string; crypto_id: number };
    quotes: { price: number; volume_24h: number }[];
  }[] }>("/v5/real-world-assets/market-pairs/list", { rwa_id: rwaId, limit: 50 }).catch((err) => {
    if (err instanceof CmcError && String(err.errorCode) === "1006") pairsUnsupported = "Market pairs are not included in this CMC API plan";
    throw err;
  });
  return (res.data.market_pairs ?? []).map((m) => ({
    exchange: m.exchange?.name,
    pair: m.market_pair,
    category: m.category,
    baseSymbol: m.market_pair_base?.symbol,
    baseCryptoId: m.market_pair_base?.crypto_id,
    price: m.quotes?.[0]?.price ?? null,
    vol24h: m.quotes?.[0]?.volume_24h ?? 0,
  }));
}

export async function assetInfo(rwaId: number) {
  const res = await cmcGet<{ rwa_assets: Record<string, unknown>[] }>("/v5/real-world-assets/info", { rwa_id: rwaId }, { ttlMs: TTL.long });
  return res.data.rwa_assets?.[0] ?? null;
}

export async function issuers() {
  const res = await cmcGet<{ issuers: { name: string; website: string | null; logo: string | null; issuer_id: string; num_tokens: number }[] }>(
    "/v5/real-world-assets/issuers/list",
    { limit: 250 },
    { ttlMs: TTL.long },
  );
  return res.data.issuers ?? [];
}

export async function issuer(issuerId: string) {
  const res = await cmcGet<{ name: string; website: string | null; tokens: { name: string; symbol: string; crypto_id: number; rwa_id: number }[]; num_tokens: number }>(
    "/v5/real-world-assets/issuers",
    { issuer_id: issuerId },
    { ttlMs: TTL.long },
  );
  return res.data;
}

export async function globalMetrics() {
  const res = await cmcGet<{
    btc_dominance: number; eth_dominance: number; stablecoin_market_cap?: number;
    quote: { USD: { total_market_cap: number; total_volume_24h: number; total_market_cap_yesterday_percentage_change?: number } };
  }>("/v1/global-metrics/quotes/latest", {}, { ttlMs: TTL.medium });
  const q = res.data.quote.USD;
  return {
    totalMcap: q.total_market_cap,
    totalVol24h: q.total_volume_24h,
    totalMcapChange24h: q.total_market_cap_yesterday_percentage_change ?? null,
    btcDominance: res.data.btc_dominance,
    ethDominance: res.data.eth_dominance,
  };
}

export async function keyInfo() {
  const res = await cmcGet<Record<string, unknown>>("/v1/key/info", {}, { ttlMs: TTL.short });
  return res.data;
}
