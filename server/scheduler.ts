/**
 * Background jobs, platform-neutral:
 *  - mark-to-market every MTM_INTERVAL_MIN while positions are open. Only the held
 *    tokens are re-quoted (1 credit per 100 tokens), so this is cheap.
 *  - the agent every settings.intervalMin when scheduling is enabled.
 *
 * Node calls tick() from a 60-second timer. Cloudflare has no long-running timers,
 * so the worker calls tick() after requests (the UI polls /api/status every 15s)
 * and from POST /api/cron, which an external cron can hit.
 */
import { pushAlert } from "./alerts.ts";
import { runAgent } from "./agent/run.ts";
import { isRunning } from "./agent/journal.ts";
import { config } from "./config.ts";
import { markToMarket, portfolioSummary } from "./portfolio.ts";
import { cryptoQuotes } from "./rwa.ts";
import { lastSnapshotRows, type ScreenRow } from "./screener.ts";
import { getSettings } from "./settings.ts";
import { jsonStore } from "./store.ts";

const state = jsonStore<{ lastMtmAt: string | null; lastAgentAt: string | null; lastError: string | null }>("scheduler.json", () => ({
  lastMtmAt: null,
  lastAgentAt: null,
  lastError: null,
}));

export function schedulerStatus() {
  const s = state.get();
  const set = getSettings();
  const base = s.lastAgentAt ? Date.parse(s.lastAgentAt) : Date.now();
  return { ...s, nextAgentAt: set.agentEnabled ? new Date(base + set.intervalMin * 60_000).toISOString() : null };
}

export async function quickMarkToMarket() {
  const held = portfolioSummary().positions;
  state.update((s) => (s.lastMtmAt = new Date().toISOString()));
  if (!held.length) return [];
  const quotes = await cryptoQuotes(held.map((p) => p.cryptoId));
  const rows = new Map<number, ScreenRow>(lastSnapshotRows().map((r) => [r.cryptoId, r]));
  for (const p of held) {
    const q = quotes.get(p.cryptoId)?.quote.USD;
    if (!q) continue;
    const prev = rows.get(p.cryptoId);
    if (prev) rows.set(p.cryptoId, { ...prev, price: q.price, vol24h: q.volume_24h ?? prev.vol24h });
    else {
      // not in the cached universe: a minimal row so stops still work
      rows.set(p.cryptoId, { cryptoId: p.cryptoId, symbol: p.symbol, name: p.name, price: q.price, vol24h: q.volume_24h ?? 0, mcap: q.market_cap ?? 0 } as ScreenRow);
    }
  }
  const exits = markToMarket(rows);
  for (const o of exits) pushAlert("risk", `exit:${o.id}`, `${o.reason.split(":")[0]} ${o.symbol}: ${o.status}`, o.reason, false);
  return exits;
}

/** Is a scheduled job due? Cheap: reads settings and timestamps only. */
export function jobDue(): "agent" | "mtm" | null {
  const set = getSettings();
  const s = state.get();
  const since = (iso: string | null) => (iso ? Date.now() - Date.parse(iso) : Infinity);
  if (set.agentEnabled && !set.killSwitch && !isRunning() && since(s.lastAgentAt) >= set.intervalMin * 60_000) return "agent";
  if (portfolioSummary().positions.length && since(s.lastMtmAt) >= config.mtmIntervalMin * 60_000) return "mtm";
  return null;
}

/** Run whatever is due (at most one job). */
export async function tick() {
  const job = jobDue();
  if (!job) return null;
  try {
    if (job === "agent") {
      state.update((s) => (s.lastAgentAt = new Date().toISOString()));
      const run = await runAgent("schedule");
      pushAlert("agent", `run:${run.id}`, `Agent run ${run.status} (${run.strategy})`, run.summary, false);
    } else {
      await quickMarkToMarket();
    }
    state.update((s) => (s.lastError = null));
  } catch (err) {
    state.update((s) => (s.lastError = (err as Error).message));
    console.warn("[scheduler]", (err as Error).message);
  }
  return job;
}

/** Node: a 60-second timer. The first scheduled agent run waits one full interval after start. */
export function startScheduler() {
  state.update((s) => (s.lastAgentAt = new Date().toISOString()));
  setInterval(() => void tick(), 60_000).unref?.();
}
