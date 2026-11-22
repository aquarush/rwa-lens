/**
 * Screener: turns the token universe into scored, filterable rows plus
 * issuer and market-level aggregates. Pure functions over RwaToken[] so the
 * web API, the MCP server and the trading agent all share one implementation.
 */
import { globalMetrics, tokenUniverse, type AssetType, type RwaAsset, type RwaToken } from "./rwa.ts";

export type Signal = "DISCOUNT" | "PREMIUM" | "MOMENTUM_UP" | "MOMENTUM_DOWN" | "REBOUND" | "ILLIQUID" | "UNIT_MISMATCH" | "LEVERAGED";

/** Leveraged / inverse ETFs decay over time and amplify moves; flag them for the risk engine. */
const LEVERAGED_TICKERS = new Set([
  "SOXL", "SOXS", "TQQQ", "SQQQ", "UPRO", "SPXL", "SPXS", "SPXU", "SDS", "SSO", "QLD", "TNA", "TZA", "LABU", "LABD", "FNGU", "FNGD",
  "KORU", "YINN", "YANG", "NVDL", "NVDU", "TSLL", "TSLQ", "TSLT", "CONL", "MSTU", "MSTX", "MSTZ", "BITX", "NUGT", "DUST", "UVXY", "SVXY", "TMF", "TMV", "UDOW", "SDOW",
]);
const LEVERAGED_NAME = /\b(2x|3x|-1x|-2x|-3x|ultra(pro)?|leveraged|inverse|bull 3|bear 3|daily (bull|bear))\b/i;
export const isLeveraged = (t: { assetSymbol: string; assetName: string; name: string }) =>
  LEVERAGED_TICKERS.has(t.assetSymbol.toUpperCase()) || LEVERAGED_NAME.test(t.assetName) || LEVERAGED_NAME.test(t.name);

export interface ScreenRow extends RwaToken {
  /**
   * Peer reference price: volume-weighted median of the sibling tokens that track the
   * same asset in comparable units. More robust than CMC's asset average, which live
   * data shows can be skewed by a token quoted in different units (e.g. one SNDK token
   * at ~$655 while the rest trade at ~$82).
   */
  refPrice: number | null;
  /** % above (+) or below (-) refPrice; null when units differ or there is no peer */
  premiumPct: number | null;
  /** number of comparable tokens that formed refPrice */
  peers: number;
  /** 24h volume / market cap */
  turnover: number | null;
  score: number;
  scores: { liquidity: number; momentum: number; value: number; size: number };
  signals: Signal[];
  tradable: boolean;
}

export interface ScreenFilter {
  q?: string;
  assetType?: AssetType;
  issuer?: string;
  minVol?: number;
  minMcap?: number;
  maxAbsPremium?: number;
  signal?: Signal;
  tradableOnly?: boolean;
  sort?: keyof ScreenRow | "score";
  dir?: "asc" | "desc";
  limit?: number;
}

/** Minimum 24h volume for a token to be considered tradable by the agent. */
export const MIN_TRADABLE_VOL = 250_000;

const clamp = (x: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Volume-weighted median price (falls back to plain median when there's no volume). */
function weightedMedian(items: { price: number; w: number }[]) {
  const total = items.reduce((a, b) => a + b.w, 0);
  if (!total) return median(items.map((i) => i.price));
  const sorted = [...items].sort((a, b) => a.price - b.price);
  let acc = 0;
  for (const i of sorted) {
    acc += i.w;
    if (acc >= total / 2) return i.price;
  }
  return sorted[sorted.length - 1].price;
}

/** Per asset: the peer reference price and which tokens share its unit. */
export function peerReferences(tokens: RwaToken[]) {
  const byAsset = new Map<number, RwaToken[]>();
  for (const t of tokens) {
    if (!byAsset.has(t.rwaId)) byAsset.set(t.rwaId, []);
    byAsset.get(t.rwaId)!.push(t);
  }
  // per token: reference = volume-weighted median of its comparable siblings, EXCLUDING itself
  // (otherwise the most-traded token is always exactly 0% from "its own" reference)
  const refs = new Map<number, { ref: number | null; peers: number; inUnit: boolean }>();
  for (const list of byAsset.values()) {
    // anchor on the most liquid tokens' unit, then keep siblings within -20%/+25% of it
    const anchor = weightedMedian(list.map((t) => ({ price: t.price, w: t.vol24h + t.mcap * 0.01 })));
    const comparable = list.filter((t) => t.price / anchor > 0.8 && t.price / anchor < 1.25);
    for (const t of list) {
      const inUnit = comparable.includes(t);
      const others = comparable.filter((o) => o !== t);
      const ref = inUnit && others.length ? weightedMedian(others.map((o) => ({ price: o.price, w: o.vol24h }))) : null;
      refs.set(t.cryptoId, { ref, peers: others.length, inUnit });
    }
  }
  return refs;
}

export function scoreTokens(tokens: RwaToken[]): ScreenRow[] {
  const refs = peerReferences(tokens);
  return tokens.map((t) => {
    const { ref: refPrice, peers, inUnit } = refs.get(t.cryptoId)!;
    const premiumPct = refPrice ? (t.price / refPrice - 1) * 100 : null;
    const turnover = t.mcap > 0 ? t.vol24h / t.mcap : null;

    const liquidity = clamp((Math.log10(Math.max(t.vol24h, 1)) - 4) / 4); // $10k -> 0, $100M -> 1
    const size = clamp((Math.log10(Math.max(t.mcap, 1)) - 5) / 5); // $100k -> 0, $10B -> 1
    const m24 = t.change24h ?? 0, m7 = t.change7d ?? 0;
    const momentum = clamp(0.5 + (0.6 * Math.tanh(m24 / 4) + 0.4 * Math.tanh(m7 / 12)) / 2);
    const value = premiumPct == null ? 0.5 : clamp(0.5 - premiumPct / 4); // -2% discount -> 1, +2% premium -> 0
    const score = Math.round(100 * (0.3 * liquidity + 0.3 * momentum + 0.25 * value + 0.15 * size));

    const signals: Signal[] = [];
    if (!inUnit) signals.push("UNIT_MISMATCH");
    if (premiumPct != null && premiumPct <= -0.5) signals.push("DISCOUNT");
    if (premiumPct != null && premiumPct >= 0.5) signals.push("PREMIUM");
    if (m24 >= 2 && m7 >= 0) signals.push("MOMENTUM_UP");
    if (m24 <= -2 && m7 <= 0) signals.push("MOMENTUM_DOWN");
    if (m7 <= -8 && m24 > 0.5) signals.push("REBOUND");
    if (isLeveraged(t)) signals.push("LEVERAGED");
    const tradable = t.vol24h >= MIN_TRADABLE_VOL;
    if (!tradable) signals.push("ILLIQUID");

    return { ...t, refPrice, premiumPct, peers, turnover, score, scores: { liquidity, momentum, value, size }, signals, tradable };
  });
}

export function filterRows(rows: ScreenRow[], f: ScreenFilter = {}) {
  let out = rows;
  if (f.q) {
    const q = f.q.toLowerCase();
    out = out.filter((r) => [r.symbol, r.name, r.assetName, r.assetSymbol, r.issuerName].some((v) => v?.toLowerCase().includes(q)));
  }
  if (f.assetType) out = out.filter((r) => r.assetType === f.assetType);
  if (f.issuer) out = out.filter((r) => r.issuerName?.toLowerCase().includes(f.issuer!.toLowerCase()) || r.issuerId === f.issuer);
  if (f.minVol) out = out.filter((r) => r.vol24h >= f.minVol!);
  if (f.minMcap) out = out.filter((r) => r.mcap >= f.minMcap!);
  if (f.maxAbsPremium != null) out = out.filter((r) => r.premiumPct != null && Math.abs(r.premiumPct) <= f.maxAbsPremium!);
  if (f.signal) out = out.filter((r) => r.signals.includes(f.signal!));
  if (f.tradableOnly) out = out.filter((r) => r.tradable);
  const key = (f.sort ?? "score") as keyof ScreenRow;
  const dir = f.dir === "asc" ? 1 : -1;
  out = [...out].sort((a, b) => {
    const av = a[key], bv = b[key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return (typeof av === "string" ? av.localeCompare(String(bv)) : Number(av) - Number(bv)) * dir;
  });
  return f.limit ? out.slice(0, f.limit) : out;
}

export function issuerScorecard(rows: ScreenRow[]) {
  const by = new Map<string, { issuerId: string | null; issuer: string; tokens: number; assets: Set<string>; assetTypes: Set<string>; mcap: number; vol24h: number; premiums: number[] }>();
  for (const r of rows) {
    const k = r.issuerName ?? "Unknown";
    if (!by.has(k)) by.set(k, { issuerId: r.issuerId, issuer: k, tokens: 0, assets: new Set(), assetTypes: new Set(), mcap: 0, vol24h: 0, premiums: [] });
    const e = by.get(k)!;
    e.tokens++;
    e.assets.add(r.assetSymbol);
    e.assetTypes.add(r.assetType);
    e.mcap += r.mcap;
    e.vol24h += r.vol24h;
    if (r.premiumPct != null) e.premiums.push(Math.abs(r.premiumPct));
  }
  return [...by.values()]
    .map((e) => ({
      issuerId: e.issuerId,
      issuer: e.issuer,
      tokens: e.tokens,
      assets: e.assets.size,
      assetTypes: [...e.assetTypes],
      mcap: e.mcap,
      vol24h: e.vol24h,
      turnover: e.mcap ? e.vol24h / e.mcap : null,
      /** average absolute deviation from the asset reference: lower = tighter peg */
      avgAbsPremiumPct: e.premiums.length ? e.premiums.reduce((a, b) => a + b, 0) / e.premiums.length : null,
    }))
    .sort((a, b) => b.mcap - a.mcap);
}

export function typeBreakdown(assets: RwaAsset[]) {
  const by: Record<string, { mcap: number; vol24h: number; assets: number }> = {};
  for (const a of assets) {
    by[a.assetType] ??= { mcap: 0, vol24h: 0, assets: 0 };
    by[a.assetType].mcap += a.mcap;
    by[a.assetType].vol24h += a.vol24h;
    by[a.assetType].assets++;
  }
  return Object.entries(by).map(([type, v]) => ({ type, ...v })).sort((a, b) => b.mcap - a.mcap);
}

let last: { at: string; assets: RwaAsset[]; rows: ScreenRow[] } | null = null;
export const lastSnapshotRows = () => last?.rows ?? [];

/** One snapshot shared by every consumer. CMC caching underneath keeps this cheap. */
export async function snapshot() {
  const { assets, tokens } = await tokenUniverse();
  const rows = scoreTokens(tokens);
  last = { at: new Date().toISOString(), assets, rows };
  return last;
}

export async function marketOverview() {
  const [{ assets, rows }, g] = await Promise.all([snapshot(), globalMetrics()]);
  const rwaMcap = assets.reduce((s, a) => s + a.mcap, 0);
  const rwaVol = assets.reduce((s, a) => s + a.vol24h, 0);
  const depegs = rows.filter((r) => r.tradable && r.premiumPct != null && Math.abs(r.premiumPct) >= 1);
  return {
    at: new Date().toISOString(),
    rwa: { tokenizedMcap: rwaMcap, vol24h: rwaVol, assets: assets.length, tokens: rows.length, tradableTokens: rows.filter((r) => r.tradable).length },
    crypto: g,
    rwaSharePct: g.totalMcap ? (rwaMcap / g.totalMcap) * 100 : null,
    byType: typeBreakdown(assets),
    depegCount: depegs.length,
    topMovers: [...rows].filter((r) => r.tradable && r.change24h != null).sort((a, b) => Math.abs(b.change24h!) - Math.abs(a.change24h!)).slice(0, 6),
    biggestDeviations: depegs.sort((a, b) => Math.abs(b.premiumPct!) - Math.abs(a.premiumPct!)).slice(0, 6),
  };
}
