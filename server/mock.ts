/**
 * Mock layer used when no CMC_API_KEY is set.
 *
 * 1. On Node, if `npm run record` saved a real response for the exact request
 *    (fixtures/recorded/<sha1>.json), cmc.ts returns that (via hooks.fixture).
 * 2. Otherwise a SYNTHETIC response is generated in the documented response
 *    shape. Prices follow a deterministic, time-based path (sum of sines plus
 *    occasional de-peg events) so the screener, alerts and the paper-trading
 *    agent have something that moves. None of these numbers are real market data.
 */
/** FNV-1a 32-bit: a tiny deterministic hash that runs anywhere (no Node crypto needed). */
function fnv(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

type AssetType = "stock" | "commodity" | "currency" | "government_security" | "etf" | "real_estate";

interface MockToken {
  symbol: string;
  name: string;
  cryptoId: number;
  issuer: string;
  /** share of the asset's tokenized market cap */
  weight: number;
  /** typical 24h volume / market cap */
  turnover: number;
}
interface MockAsset {
  rwaId: number;
  name: string;
  symbol: string;
  type: AssetType;
  base: number;
  vol: number; // annualised-ish wiggle amplitude
  tokenizedMcap: number;
  ticker?: { exchange: string; ticker: string };
  tokens: MockToken[];
}

const ISSUERS: Record<string, { id: string; website: string }> = {};
const issuerId = (name: string) => [0, 1, 2].map((i) => fnv(`${i}:${name}`).toString(16).padStart(8, "0")).join("");
function iss(name: string, website: string) {
  ISSUERS[name] = { id: issuerId(name), website };
  return name;
}
const PAXOS = iss("Paxos", "https://paxos.com");
const TETHER = iss("Tether", "https://tether.to");
const KINESIS = iss("Kinesis", "https://kinesis.money");
const BACKED = iss("Backed Finance (xStocks)", "https://backed.fi");
const ONDO = iss("Ondo Finance", "https://ondo.finance");
const SECURITIZE = iss("Securitize", "https://securitize.io");
const CIRCLE = iss("Circle (Hashnote)", "https://circle.com");
const FRANKLIN = iss("Franklin Templeton", "https://franklintempleton.com");
const SUPERSTATE = iss("Superstate", "https://superstate.co");
const REALT = iss("RealT", "https://realt.co");
const STASIS = iss("STASIS", "https://stasis.net");

let nextCryptoId = 990001;
const t = (symbol: string, name: string, issuer: string, weight: number, turnover: number): MockToken => ({
  symbol, name, issuer, weight, turnover, cryptoId: nextCryptoId++,
});

const ASSETS: MockAsset[] = [
  { rwaId: 1, name: "Gold", symbol: "GOLD", type: "commodity", base: 2650, vol: 0.05, tokenizedMcap: 2.4e9,
    tokens: [t("PAXG", "PAX Gold", PAXOS, 0.48, 0.09), t("XAUT", "Tether Gold", TETHER, 0.47, 0.06), t("KAU", "Kinesis Gold", KINESIS, 0.05, 0.01)] },
  { rwaId: 2, name: "Silver", symbol: "SILVER", type: "commodity", base: 31, vol: 0.08, tokenizedMcap: 6.5e7,
    tokens: [t("KAG", "Kinesis Silver", KINESIS, 1, 0.02)] },
  { rwaId: 3, name: "US Treasury Bills (tokenized funds)", symbol: "USTB", type: "government_security", base: 1.0, vol: 0.0006, tokenizedMcap: 7.1e9,
    tokens: [t("BUIDL", "BlackRock USD Institutional Digital Liquidity Fund", SECURITIZE, 0.36, 0.004), t("USYC", "US Yield Coin", CIRCLE, 0.2, 0.006),
      t("BENJI", "Franklin OnChain U.S. Government Money Fund", FRANKLIN, 0.12, 0.003), t("USDY", "Ondo US Dollar Yield", ONDO, 0.14, 0.02),
      t("OUSG", "Ondo Short-Term US Government Bond Fund", ONDO, 0.1, 0.008), t("USTB", "Superstate Short Duration US Government Securities Fund", SUPERSTATE, 0.08, 0.005)] },
  { rwaId: 4, name: "NVIDIA", symbol: "NVDA", type: "stock", base: 140, vol: 0.12, tokenizedMcap: 1.9e8, ticker: { exchange: "Nasdaq", ticker: "NVDA" },
    tokens: [t("NVDAx", "NVIDIA xStock", BACKED, 0.6, 0.35), t("NVDAon", "NVIDIA (Ondo Tokenized)", ONDO, 0.4, 0.22)] },
  { rwaId: 5, name: "Tesla", symbol: "TSLA", type: "stock", base: 330, vol: 0.16, tokenizedMcap: 1.4e8, ticker: { exchange: "Nasdaq", ticker: "TSLA" },
    tokens: [t("TSLAx", "Tesla xStock", BACKED, 0.55, 0.42), t("TSLAon", "Tesla (Ondo Tokenized)", ONDO, 0.45, 0.25)] },
  { rwaId: 6, name: "Apple", symbol: "AAPL", type: "stock", base: 230, vol: 0.08, tokenizedMcap: 9.5e7, ticker: { exchange: "Nasdaq", ticker: "AAPL" },
    tokens: [t("AAPLx", "Apple xStock", BACKED, 0.5, 0.2), t("AAPLon", "Apple (Ondo Tokenized)", ONDO, 0.5, 0.15)] },
  { rwaId: 7, name: "SPDR S&P 500 ETF", symbol: "SPY", type: "etf", base: 600, vol: 0.05, tokenizedMcap: 2.1e8, ticker: { exchange: "NYSE Arca", ticker: "SPY" },
    tokens: [t("SPYx", "SP500 xStock", BACKED, 0.55, 0.12), t("SPYon", "SPY (Ondo Tokenized)", ONDO, 0.45, 0.09)] },
  { rwaId: 8, name: "Invesco QQQ", symbol: "QQQ", type: "etf", base: 510, vol: 0.07, tokenizedMcap: 1.1e8, ticker: { exchange: "Nasdaq", ticker: "QQQ" },
    tokens: [t("QQQx", "Nasdaq xStock", BACKED, 0.6, 0.14), t("QQQon", "QQQ (Ondo Tokenized)", ONDO, 0.4, 0.1)] },
  { rwaId: 9, name: "Euro", symbol: "EUR", type: "currency", base: 1.06, vol: 0.01, tokenizedMcap: 2.3e8,
    tokens: [t("EURS", "STASIS EURO", STASIS, 1, 0.03)] },
  { rwaId: 10, name: "Detroit Residential Real Estate", symbol: "REALT-DET", type: "real_estate", base: 52, vol: 0.004, tokenizedMcap: 1.3e8,
    tokens: [t("REALTOKEN", "RealToken Basket", REALT, 1, 0.002)] },
];

const ALL_TOKENS = ASSETS.flatMap((a) => a.tokens.map((tk) => ({ asset: a, token: tk })));
export const MOCK_TOKEN_IDS = ALL_TOKENS.map((x) => x.token.cryptoId);

// ---------- deterministic price paths ----------
function hashNum(s: string) {
  return fnv(s) / 0xffffffff;
}
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Asset reference ("underlying") price at time ms. */
function assetPrice(a: MockAsset, ms: number) {
  const p = hashNum(a.symbol) * Math.PI * 2;
  const days = ms / DAY;
  const drift = Math.sin(days / 90 + p) * 0.5 + Math.sin(days / 23 + p * 2) * 0.3 + Math.sin(days / 4.1 + p * 3) * 0.15 + Math.sin(ms / (37 * 60_000) + p) * 0.05;
  return a.base * (1 + a.vol * drift);
}

/** Token deviation (fraction) from the asset price: small wobble + periodic de-peg episodes. */
function tokenDeviation(a: MockAsset, tk: MockToken, ms: number) {
  const p = hashNum(tk.symbol) * Math.PI * 2;
  const spread = a.type === "government_security" || a.type === "real_estate" ? 0.0008 : a.type === "stock" ? 0.004 : 0.0025;
  let dev = spread * (Math.sin(ms / (5.3 * HOUR) + p) * 0.6 + Math.sin(ms / (47 * 60_000) + p * 2) * 0.4);
  // de-peg episode: each token has a ~6h window every ~3 days where it trades off its reference
  const cycle = 3 * DAY + hashNum(tk.symbol + "c") * DAY;
  const phase = (ms + hashNum(tk.symbol + "o") * cycle) % cycle;
  if (phase < 6 * HOUR) {
    const depth = (hashNum(tk.symbol + "d") - 0.5) * (a.type === "stock" ? 0.05 : a.type === "government_security" ? 0.006 : 0.03);
    dev += depth * Math.sin((phase / (6 * HOUR)) * Math.PI);
  }
  return dev;
}

function tokenPrice(a: MockAsset, tk: MockToken, ms: number) {
  return assetPrice(a, ms) * (1 + tokenDeviation(a, tk, ms));
}
function tokenMcap(a: MockAsset, tk: MockToken, ms: number) {
  const growth = 1 + 0.08 * Math.sin(ms / (30 * DAY) + hashNum(tk.symbol));
  return a.tokenizedMcap * tk.weight * growth * (tokenPrice(a, tk, ms) / a.base);
}
function tokenVolume(a: MockAsset, tk: MockToken, ms: number) {
  const wiggle = 1 + 0.5 * Math.sin(ms / (9 * HOUR) + hashNum(tk.symbol + "v") * 6);
  return tokenMcap(a, tk, ms) * tk.turnover * wiggle;
}

function assetAgg(a: MockAsset, ms: number) {
  let mcap = 0, vol = 0, pxw = 0;
  for (const tk of a.tokens) {
    const m = tokenMcap(a, tk, ms);
    mcap += m;
    vol += tokenVolume(a, tk, ms);
    pxw += tokenPrice(a, tk, ms) * m;
  }
  return { mcap, vol, avgPrice: pxw / mcap };
}

// ---------- response builders ----------
const iso = (ms: number) => new Date(ms).toISOString();
const r = (n: number, d = 6) => Number(n.toFixed(d));

function status(credits = 1, total?: number) {
  return { timestamp: new Date().toISOString(), error_code: 0, error_message: null, elapsed: 3, credit_count: credits, notice: "SYNTHETIC MOCK DATA - not real market data", total_count: total };
}

function pickAssets(p: Record<string, string>): MockAsset[] {
  if (p.rwa_id) {
    const ids = p.rwa_id.split(",").map(Number);
    return ASSETS.filter((a) => ids.includes(a.rwaId));
  }
  if (p.symbol) {
    const syms = p.symbol.toUpperCase().split(",");
    return ASSETS.filter((a) => syms.includes(a.symbol.toUpperCase()));
  }
  if (p.rwa_slug) {
    const slugs = p.rwa_slug.split(",");
    return ASSETS.filter((a) => slugs.includes(slug(a.name)));
  }
  return ASSETS;
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

function baseFields(a: MockAsset, rank: number) {
  return { name: a.name, symbol: a.symbol, slug: slug(a.name), rwa_id: a.rwaId, asset_type: a.type, rwa_rank: rank, has_tokens: a.tokens.length > 0 };
}

function rankOf(a: MockAsset, now: number) {
  const sorted = [...ASSETS].sort((x, y) => assetAgg(y, now).mcap - assetAgg(x, now).mcap);
  return sorted.indexOf(a) + 1;
}

function quoteRow(a: MockAsset, now: number) {
  const agg = assetAgg(a, now);
  return {
    ...baseFields(a, rankOf(a, now)),
    quotes: [{ symbol: "USD", crypto_id: 2781, average_tokenized_price: r(agg.avgPrice), tokenized_market_cap: r(agg.mcap, 2), tokenized_volume_24h: r(agg.vol, 2), last_updated: iso(now) }],
    average_tokenized_price: r(agg.avgPrice),
    tokenized_market_cap: r(agg.mcap, 2),
    tokenized_volume_24h: r(agg.vol, 2),
    last_updated: iso(now),
  };
}

function paginate<T>(rows: T[], p: Record<string, string>) {
  const start = Math.max(1, Number(p.start ?? 1));
  const limit = Math.min(250, Math.max(1, Number(p.limit ?? 100)));
  return { page: rows.slice(start - 1, start - 1 + limit), total: rows.length, hasMore: start - 1 + limit < rows.length };
}

export function mockResponse(endpoint: string, p: Record<string, string>): unknown {
  const now = Date.now();

  switch (endpoint) {
    case "/v5/real-world-assets/map": {
      let rows = ASSETS.filter((a) => !p.asset_type || a.type === p.asset_type).map((a) => ({
        ...baseFields(a, rankOf(a, now)), first_historical_data: "2020-01-01T00:00:00.000Z", last_historical_data: iso(now),
      }));
      if (p.symbol) rows = rows.filter((x) => p.symbol.toUpperCase().split(",").includes(x.symbol));
      const pg = paginate(rows, p);
      return { data: { rwa_assets: pg.page, total_size: pg.total, has_more: pg.hasMore }, status: status(1, pg.total) };
    }

    case "/v5/real-world-assets/info":
      return {
        data: { rwa_assets: pickAssets(p).map((a) => ({
          ...baseFields(a, rankOf(a, now)), website: null, employees: null, founded: null, industry: a.type === "stock" ? "Technology" : null, cik: null,
          about: { description: `${a.name} (synthetic mock description).`, logo: null, website: null, date_added: "2024-01-01T00:00:00.000Z" },
          primary_exchange: a.ticker?.exchange ?? null,
        })) },
        status: status(1),
      };

    case "/v5/real-world-assets/assets/list": {
      let rows = pickAssets(p).filter((a) => !p.asset_type || a.type === p.asset_type).map((a) => quoteRow(a, now));
      const sort = p.sort ?? "rwa_rank";
      const dir = (p.sort_dir ?? "asc") === "asc" ? 1 : -1;
      rows.sort((x, y) => {
        const xv = (x as Record<string, unknown>)[sort], yv = (y as Record<string, unknown>)[sort];
        return (typeof xv === "string" ? String(xv).localeCompare(String(yv)) : Number(xv) - Number(yv)) * dir;
      });
      const pg = paginate(rows, p);
      return { data: { total_size: pg.total, has_more: pg.hasMore, rwa_assets: pg.page }, status: status(1, pg.total) };
    }

    case "/v5/real-world-assets/quotes/latest":
      return {
        data: { rwa_assets: pickAssets(p).map((a) => ({
          ...quoteRow(a, now),
          tokens: a.tokens.map((tk) => ({
            symbol: tk.symbol, name: tk.name, price: r(tokenPrice(a, tk, now)), crypto_id: tk.cryptoId,
            issuer_id: ISSUERS[tk.issuer].id, issuer_name: tk.issuer, market_cap: r(tokenMcap(a, tk, now), 2), volume_24h: r(tokenVolume(a, tk, now), 2),
          })),
          tradfi_markets: a.ticker ? [{ exchange: { slug: slug(a.ticker.exchange), name: a.ticker.exchange, exchange_id: 0 }, ticker: a.ticker.ticker, market_url: null }] : [],
        })) },
        status: status(1),
      };

    case "/v5/real-world-assets/quotes/historical": {
      const step = ({ hourly: HOUR, daily: DAY, weekly: 7 * DAY, monthly: 30 * DAY, "1h": HOUR, "4h": 4 * HOUR, "1d": DAY } as Record<string, number>)[p.interval ?? "daily"] ?? DAY;
      const count = Math.min(10000, Number(p.count ?? 10));
      let end = p.time_end ? Date.parse(p.time_end) || Number(p.time_end) * 1000 : now;
      let start = p.time_start ? Date.parse(p.time_start) || Number(p.time_start) * 1000 : end - (count - 1) * step;
      if (p.time_start && !p.time_end) end = Math.min(now, start + (count - 1) * step);
      start = Math.floor(start / step) * step;
      const points: number[] = [];
      for (let ts = start; ts <= end && points.length < count; ts += step) points.push(ts);
      return {
        data: { rwa_assets: pickAssets(p).map((a) => ({
          ...baseFields(a, rankOf(a, now)),
          quotes: points.map((ts) => {
            const agg = assetAgg(a, ts);
            return { timestamp: iso(ts), convert_id: 2781, convert_symbol: "USD", average_tokenized_price: r(agg.avgPrice), tokenized_market_cap: r(agg.mcap, 2), tokenized_volume_24h: r(agg.vol, 2) };
          }),
        })) },
        status: status(Math.max(1, Math.ceil(points.length / 100))),
      };
    }

    case "/v5/real-world-assets/market-pairs/list": {
      const a = pickAssets(p)[0];
      if (!a) return { data: { market_pairs: [], num_market_pairs: 0, total_size: 0, has_more: false }, status: status(1) };
      const venues = [["Binance", 270], ["Kraken", 24], ["Bybit", 521], ["Uniswap v3 (Ethereum)", 1348]] as const;
      const pairs = a.tokens.flatMap((tk, i) => venues.slice(0, 2 + (i % 2)).map(([ex, exId], j) => {
        const px = tokenPrice(a, tk, now) * (1 + (j - 1) * 0.0007);
        const vol = tokenVolume(a, tk, now) * (j === 0 ? 0.55 : 0.25);
        return {
          exchange: { exchange_id: exId, name: ex, slug: slug(ex) }, market_id: tk.cryptoId * 10 + j, market_pair: `${tk.symbol}/USDT`, category: "spot", fee_type: "percentage",
          market_pair_base: { crypto_id: tk.cryptoId, symbol: tk.symbol, exchange_symbol: tk.symbol, currency_type: "cryptocurrency" },
          market_pair_quote: { crypto_id: 825, symbol: "USDT", exchange_symbol: "USDT", currency_type: "cryptocurrency" },
          exchange_reported_quotes: { price: r(px), volume_24h_base: r(vol / px, 4), volume_24h_quote: r(vol, 2), last_updated: iso(now) },
          quotes: [{ crypto_id: 2781, symbol: "USD", price: r(px), volume_24h: r(vol, 2), last_updated: iso(now) }],
        };
      })).sort((x, y) => y.quotes[0].volume_24h - x.quotes[0].volume_24h);
      const pg = paginate(pairs, p);
      return { data: { rwa_id: a.rwaId, name: a.name, symbol: a.symbol, num_market_pairs: pairs.length, market_pairs: pg.page, total_size: pg.total, has_more: pg.hasMore }, status: status(1) };
    }

    case "/v5/real-world-assets/issuers/list": {
      let rows = Object.entries(ISSUERS).map(([name, v]) => ({ name, website: v.website, logo: null, issuer_id: v.id, num_tokens: ALL_TOKENS.filter((x) => x.token.issuer === name).length }));
      if (p.issuer_id) rows = rows.filter((x) => p.issuer_id.split(",").includes(x.issuer_id));
      const pg = paginate(rows, p);
      return { data: { issuers: pg.page, total_size: pg.total, has_more: pg.hasMore }, status: status(1, pg.total) };
    }

    case "/v5/real-world-assets/issuers": {
      const entry = Object.entries(ISSUERS).find(([, v]) => v.id === p.issuer_id);
      if (!entry) return { data: null, status: { ...status(0), error_code: 400, error_message: "Invalid value for \"issuer_id\"" } };
      const tokens = ALL_TOKENS.filter((x) => x.token.issuer === entry[0]).map((x) => ({ name: x.token.name, symbol: x.token.symbol, crypto_id: x.token.cryptoId, rwa_id: x.asset.rwaId }));
      return { data: { name: entry[0], website: entry[1].website, logo: null, tokens, issuer_id: entry[1].id, num_tokens: tokens.length, total_size: tokens.length, has_more: false }, status: status(1) };
    }

    case "/v2/cryptocurrency/quotes/latest": {
      const ids = (p.id ?? "").split(",").map(Number).filter(Boolean);
      const data: Record<string, unknown> = {};
      for (const id of ids) {
        const hit = ALL_TOKENS.find((x) => x.token.cryptoId === id);
        if (!hit) continue;
        const { asset: a, token: tk } = hit;
        const px = (ms: number) => tokenPrice(a, tk, ms);
        const pct = (ms: number) => r(((px(now) - px(now - ms)) / px(now - ms)) * 100, 4);
        data[id] = {
          id, name: tk.name, symbol: tk.symbol, slug: slug(tk.name), is_active: 1, cmc_rank: null, tags: [{ slug: "tokenized-assets", name: "Tokenized Assets", category: "CATEGORY" }],
          quote: { USD: {
            price: r(px(now)), volume_24h: r(tokenVolume(a, tk, now), 2), percent_change_1h: pct(HOUR), percent_change_24h: pct(DAY), percent_change_7d: pct(7 * DAY), percent_change_30d: pct(30 * DAY),
            market_cap: r(tokenMcap(a, tk, now), 2), fully_diluted_market_cap: r(tokenMcap(a, tk, now), 2), last_updated: iso(now),
          } },
        };
      }
      return { data, status: status(Math.max(1, Math.ceil(ids.length / 100))) };
    }

    case "/v1/global-metrics/quotes/latest": {
      const days = now / DAY;
      const total = 3.1e12 * (1 + 0.06 * Math.sin(days / 11) + 0.02 * Math.sin(days / 1.7));
      const totalY = 3.1e12 * (1 + 0.06 * Math.sin((days - 1) / 11) + 0.02 * Math.sin((days - 1) / 1.7));
      return {
        data: {
          active_cryptocurrencies: 9800, btc_dominance: r(58 + 2 * Math.sin(days / 13), 3), eth_dominance: r(11 + Math.sin(days / 9), 3), stablecoin_market_cap: 2.6e11,
          quote: { USD: { total_market_cap: r(total, 2), total_volume_24h: r(total * 0.035, 2), total_market_cap_yesterday_percentage_change: r(((total - totalY) / totalY) * 100, 4), last_updated: iso(now) } },
          last_updated: iso(now),
        },
        status: status(1),
      };
    }

    case "/v1/key/info":
      return { data: { plan: { credit_limit_monthly: 0, rate_limit_minute: 0 }, usage: { current_minute: { requests_made: 0 }, current_day: { credits_used: 0 }, current_month: { credits_used: 0, credits_left: 0 } } }, status: status(0) };
  }
  return { data: null, status: { ...status(0), error_code: 404, error_message: `Mock has no handler for ${endpoint}` } };
}
