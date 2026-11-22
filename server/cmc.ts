/**
 * CoinMarketCap Pro API client.
 *
 * - Keeps the API key server-side (header X-CMC_PRO_API_KEY).
 * - In-memory TTL cache keyed by path + sorted params, to save credits.
 * - Every LIVE call is appended to evidence/cmc-calls.jsonl with the key redacted.
 * - With no key, requests are answered by the mock layer (recorded fixtures first,
 *   then a synthetic generator) so the app runs end-to-end for judges.
 */
import fs from "node:fs";
import path from "node:path";
import { config, mockMode } from "./config.ts";
import { fixtureFileFor, mockResponse } from "./mock.ts";

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
const stats = { live: 0, cache: 0, mock: 0, errors: 0, credits: 0, budgetBlocked: 0, since: new Date().toISOString() };

// ---- daily credit budget (persisted so restarts don't reset it) ----
const DAILY_BUDGET = Number(process.env.CMC_DAILY_CREDIT_BUDGET ?? 600);
const creditsFile = () => path.join(config.dataDir, "credits.json");
const today = () => new Date().toISOString().slice(0, 10);
let ledger: { day: string; used: number } = (() => {
  try {
    const l = JSON.parse(fs.readFileSync(creditsFile(), "utf8"));
    return l.day === today() ? l : { day: today(), used: 0 };
  } catch {
    return { day: today(), used: 0 };
  }
})();
function readLedger() {
  try {
    const l = JSON.parse(fs.readFileSync(creditsFile(), "utf8"));
    if (l.day === today()) return l as typeof ledger;
  } catch {}
  return { day: today(), used: 0 };
}
function spend(credits: number) {
  // re-read first: the MCP server and the web app may both be spending
  ledger = readLedger();
  ledger.used += credits;
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(creditsFile(), JSON.stringify(ledger));
  } catch {}
}
export const budget = () => {
  ledger = readLedger();
  return { day: ledger.day, used: ledger.used, limit: DAILY_BUDGET, remaining: Math.max(0, DAILY_BUDGET - ledger.used) };
};
const RECORD = process.env.CMC_RECORD === "1";

function cleanParams(params: Params): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(params).sort()) {
    const v = params[k];
    if (v === undefined || v === null || v === "") continue;
    out[k] = String(v);
  }
  return out;
}

function remember(rec: CallRecord) {
  recent.unshift(rec);
  if (recent.length > 200) recent.pop();
}

function writeEvidence(rec: CallRecord, body: unknown) {
  try {
    fs.mkdirSync(config.evidenceDir, { recursive: true });
    const text = JSON.stringify(body);
    const line = JSON.stringify({
      ...rec,
      url: `${config.cmcBase}${rec.endpoint}?${new URLSearchParams(rec.params)}`,
      headers: { "X-CMC_PRO_API_KEY": "<redacted>" },
      responseBytes: text.length,
      responsePreview: text.slice(0, 1500),
    });
    fs.appendFileSync(path.join(config.evidenceDir, "cmc-calls.jsonl"), line + "\n");
  } catch (err) {
    console.warn("[cmc] could not write evidence:", (err as Error).message);
  }
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
      const body = mockResponse(endpoint, p) as CmcEnvelope<T>;
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
      throw new CmcError(`Daily CMC credit budget (${DAILY_BUDGET}) exhausted; raise CMC_DAILY_CREDIT_BUDGET to continue`, 429, "budget", endpoint);
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
    const rec: CallRecord = {
      at: new Date().toISOString(),
      endpoint,
      params: p,
      source: "live",
      httpStatus: res.status,
      credits,
      elapsedMs: Date.now() - started,
    };
    stats.live++;
    stats.credits += credits;
    spend(credits);
    // note: RWA endpoints return error_code as the string "0", classic ones as the number 0
    const errorCode = body.status?.error_code ?? (res.ok ? 0 : res.status);
    if (!res.ok || String(errorCode) !== "0") {
      stats.errors++;
      rec.error = body.status?.error_message ?? `HTTP ${res.status}`;
      remember(rec);
      writeEvidence(rec, body);
      throw new CmcError(`CMC ${endpoint} failed: ${rec.error}`, res.status, errorCode, endpoint);
    }
    remember(rec);
    writeEvidence(rec, body);
    if (RECORD) {
      const file = fixtureFileFor(endpoint, p);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(body));
    }
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

export function readEvidence(limit = 50): unknown[] {
  const file = path.join(config.evidenceDir, "cmc-calls.jsonl");
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  return lines.slice(-limit).reverse().map((l) => JSON.parse(l));
}
