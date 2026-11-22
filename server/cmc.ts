/**
 * CoinMarketCap Pro API client (platform-neutral: Node and Cloudflare Workers).
 *
 * - Keeps the API key server-side (header X-CMC_PRO_API_KEY).
 * - In-memory TTL cache keyed by path + sorted params, plus in-flight de-duplication.
 * - Every LIVE call is recorded with the key redacted: in the evidence store (shown
 *   on the API Evidence page) and, on Node, appended to evidence/cmc-calls.jsonl.
 * - A persisted daily credit budget serves stale cache rather than overspending.
 * - With no key, requests are answered by the mock layer (recorded fixtures first,
 *   then a synthetic generator) so the app runs end-to-end without a key.
 */
import { config, hooks, mockMode } from "./config.ts";
import { mockResponse } from "./mock.ts";
import { jsonStore } from "./store.ts";

export interface CmcStatus {
  timestamp: string;
  error_code: number | string;
  error_message: string | null;
  elapsed: number;
  credit_count: number;
  notice?: string | null;
  total_count?: number;
}
export interface CmcEnvelope<T> {
  data: T;
  status: CmcStatus;
}

export class CmcError extends Error {
  constructor(
    message: string,
    public httpStatus: number,
    public errorCode: number | string,
    public endpoint: string,
  ) {
    super(message);
  }
}

export type Params = Record<string, string | number | boolean | undefined | null>;

export interface CallRecord {
  at: string;
  endpoint: string;
  params: Record<string, string>;
  source: "live" | "cache" | "mock";
  httpStatus: number;
  credits: number;
  elapsedMs: number;
  error?: string;
}

const cache = new Map<string, { expires: number; value: CmcEnvelope<unknown> }>();
const inflight = new Map<string, Promise<CmcEnvelope<unknown>>>();
const recent: CallRecord[] = [];
const stats = { live: 0, cache: 0, mock: 0, errors: 0, credits: 0, budgetBlocked: 0, since: "" };

// ---- persisted state: daily credit ledger + evidence log ----
const today = () => new Date().toISOString().slice(0, 10);
const ledger = jsonStore<{ day: string; used: number }>("credits.json", () => ({ day: "", used: 0 }));
const evidence = jsonStore<{ calls: Record<string, unknown>[] }>("evidence.json", () => ({ calls: [] }));

function spend(credits: number) {
  ledger.update((l) => {
    if (l.day !== today()) {
      l.day = today();
      l.used = 0;
    }
    l.used += credits;
  });
}
export const budget = () => {
  const l = ledger.get();
  const used = l.day === today() ? l.used : 0;
  return { day: today(), used, limit: config.dailyCreditBudget, remaining: Math.max(0, config.dailyCreditBudget - used) };
};

function remember(rec: CallRecord) {
  recent.unshift(rec);
  if (recent.length > 200) recent.pop();
}

function writeEvidence(rec: CallRecord, body: unknown) {
  const text = JSON.stringify(body);
  const line = {
    ...rec,
    url: `${config.cmcBase}${rec.endpoint}?${new URLSearchParams(rec.params)}`,
    headers: { "X-CMC_PRO_API_KEY": "<redacted>" },
    responseBytes: text.length,
    responsePreview: text.slice(0, 1200),
  };
  evidence.update((e) => {
    e.calls.push(line);
    if (e.calls.length > 60) e.calls = e.calls.slice(-60);
  });
  hooks.evidence?.(line);
}

function cleanParams(params: Params): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(params).sort()) {
    const v = params[k];
    if (v === undefined || v === null || v === "") continue;
    out[k] = String(v);
  }
  return out;
}

/** Default cache TTLs mirror CMC's own server-side cache intervals. */
export const TTL = {
  short: 60_000,
  medium: 5 * 60_000,
  long: 30 * 60_000,
};

export async function cmcGet<T>(
  endpoint: string,
  params: Params = {},
  opts: { ttlMs?: number; force?: boolean } = {},
): Promise<CmcEnvelope<T>> {
  stats.since ||= new Date().toISOString();
  const p = cleanParams(params);
  const key = `${endpoint}?${new URLSearchParams(p)}`;
  const ttl = opts.ttlMs ?? TTL.short;

  const hit = cache.get(key);
  if (!opts.force && hit && hit.expires > Date.now()) {
    stats.cache++;
    return hit.value as CmcEnvelope<T>;
  }
  const pending = inflight.get(key);
  if (pending) return pending as Promise<CmcEnvelope<T>>;

  const run = (async () => {
    const started = Date.now();
    if (mockMode()) {
      const body = ((hooks.fixture?.(key) as CmcEnvelope<T> | null) ?? mockResponse(endpoint, p)) as CmcEnvelope<T>;
      stats.mock++;
      if (String(body.status?.error_code ?? 0) !== "0") {
        throw new CmcError(`CMC(mock) ${endpoint} failed: ${body.status.error_message}`, 400, body.status.error_code, endpoint);
      }
      remember({ at: new Date().toISOString(), endpoint, params: p, source: "mock", httpStatus: 200, credits: 0, elapsedMs: Date.now() - started });
      cache.set(key, { expires: Date.now() + Math.min(ttl, 30_000), value: body });
      return body;
    }

    if (budget().remaining <= 0 && endpoint !== "/v1/key/info") {
      stats.budgetBlocked++;
      if (hit) return hit.value as CmcEnvelope<T>; // serve stale rather than overspend
      throw new CmcError(`Daily CMC credit budget (${config.dailyCreditBudget}) exhausted; raise CMC_DAILY_CREDIT_BUDGET to continue`, 429, "budget", endpoint);
    }
    const url = `${config.cmcBase}${endpoint}?${new URLSearchParams(p)}`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "X-CMC_PRO_API_KEY": config.cmcKey, Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      stats.errors++;
      const msg = (err as Error).message;
      remember({ at: new Date().toISOString(), endpoint, params: p, source: "live", httpStatus: 0, credits: 0, elapsedMs: Date.now() - started, error: msg });
      throw new CmcError(`Network error calling ${endpoint}: ${msg}`, 0, "network", endpoint);
    }
    const body = (await res.json().catch(() => ({}))) as Partial<CmcEnvelope<T>>;
    const credits = Number(body.status?.credit_count ?? 0);
    const rec: CallRecord = { at: new Date().toISOString(), endpoint, params: p, source: "live", httpStatus: res.status, credits, elapsedMs: Date.now() - started };
    stats.live++;
    stats.credits += credits;
    spend(credits);
    // note: RWA endpoints return error_code as the string "0", classic ones as the number 0
    const errorCode = body.status?.error_code ?? (res.ok ? 0 : res.status);
    if (!res.ok || String(errorCode) !== "0") {
      stats.errors++;
      rec.error = body.status?.error_message || `HTTP ${res.status}`;
      remember(rec);
      writeEvidence(rec, body);
      throw new CmcError(`CMC ${endpoint} failed: ${rec.error}`, res.status, errorCode, endpoint);
    }
    remember(rec);
    writeEvidence(rec, body);
    hooks.record?.(key, body);
    const value = body as CmcEnvelope<T>;
    cache.set(key, { expires: Date.now() + ttl, value });
    return value;
  })();

  inflight.set(key, run);
  try {
    return await run;
  } finally {
    inflight.delete(key);
  }
}

export function cmcStats() {
  return { mode: mockMode() ? "mock" : "live", ...stats, budget: budget(), cacheEntries: cache.size, recent: recent.slice(0, 50) };
}

export const readEvidence = (limit = 50) => evidence.get().calls.slice(-limit).reverse();
