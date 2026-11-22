/**
 * Background jobs:
 *  - mark-to-market every MTM_INTERVAL_MIN (default 10) while positions are open.
 *    Only the held tokens are re-quoted (1 credit per 100 tokens), so this is cheap.
 *  - the agent every settings.intervalMin when the scheduler is enabled.
 */
import { pushAlert } from "./alerts.ts";
import { runAgent } from "./agent/run.ts";
import { isRunning } from "./agent/journal.ts";
import { markToMarket, portfolioSummary } from "./portfolio.ts";
import { cryptoQuotes } from "./rwa.ts";
import { lastSnapshotRows, type ScreenRow } from "./screener.ts";
import { getSettings } from "./settings.ts";

const MTM_MIN = Number(process.env.MTM_INTERVAL_MIN ?? 10);
let lastAgentAt = 0;
export const schedulerState = {
  lastMtmAt: null as string | null,
  lastAgentAt: null as string | null,
  nextAgentAt: null as string | null,
  lastError: null as string | null,
};

export async function quickMarkToMarket() {
  const held = portfolioSummary().positions;
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
  schedulerState.lastMtmAt = new Date().toISOString();
  return exits;
}

async function tick() {
  try {
    const s = getSettings();
    if (s.agentEnabled && !s.killSwitch && !isRunning() && Date.now() - lastAgentAt >= s.intervalMin * 60_000) {
      lastAgentAt = Date.now();
      schedulerState.lastAgentAt = new Date().toISOString();
      const run = await runAgent("schedule");
      pushAlert("agent", `run:${run.id}`, `Agent run ${run.status} (${run.engine})`, run.summary, false);
    } else if (!schedulerState.lastMtmAt || Date.now() - Date.parse(schedulerState.lastMtmAt) >= MTM_MIN * 60_000) {
      await quickMarkToMarket();
    }
    schedulerState.nextAgentAt = s.agentEnabled ? new Date(lastAgentAt + s.intervalMin * 60_000).toISOString() : null;
    schedulerState.lastError = null;
  } catch (err) {
    schedulerState.lastError = (err as Error).message;
    console.warn("[scheduler]", (err as Error).message);
  }
}

export function startScheduler() {
  // the first scheduled agent run waits one full interval, so restarts don't trigger trades
  lastAgentAt = Date.now();
  setInterval(tick, 60_000).unref();
}
