/**
 * The RWA Lens trading agent: a transparent, rule-based decision loop driven
 * entirely by CoinMarketCap data. No LLM or other external AI service is used.
 *
 * Each run:
 *  1. READ THE MARKET   /v1/global-metrics/quotes/latest -> regime (risk-on / neutral / risk-off)
 *  2. REVIEW POSITIONS  exit on momentum breaks, harvest premiums vs peers, otherwise hold
 *  3. SCREEN            tokenized-RWA universe (/v5/real-world-assets/* + /v2 quotes), filter by
 *                       strategy style, liquidity, score and risk settings; best-priced sibling per asset
 *  4. RESEARCH          /v5/real-world-assets/quotes/historical for each shortlisted asset:
 *                       30-day return, daily volatility, drawdown -> reject falling knives
 *  5. SIZE & ACT        volatility-targeted size, scaled by regime; every order goes through riskCheck()
 *
 * Every observation and decision is written to the run journal, so the "why" is always visible.
 */
import { assetHistory } from "../rwa.ts";
import { globalMetrics } from "../rwa.ts";
import { portfolioSummary } from "../portfolio.ts";
import type { ScreenRow } from "../screener.ts";
import { getSettings, type Settings } from "../settings.ts";
import { step, type AgentRun } from "./journal.ts";
import { compactRow, toolPlaceOrder, type ToolContext } from "./tools.ts";

export type Regime = "risk-on" | "neutral" | "risk-off";

/** Market regime from the total crypto market's 24h move (tokenized RWAs trade on the same venues). */
export function regimeFrom(change24h: number | null | undefined): { regime: Regime; sizeMult: number; why: string } {
  const c = change24h ?? 0;
  if (c <= -3) return { regime: "risk-off", sizeMult: 0.5, why: `total crypto market cap ${c.toFixed(2)}% in 24h: halve new position sizes and skip momentum entries` };
  if (c >= 2) return { regime: "risk-on", sizeMult: 1, why: `total crypto market cap +${c.toFixed(2)}% in 24h: full size` };
  return { regime: "neutral", sizeMult: 0.85, why: `total crypto market cap ${c >= 0 ? "+" : ""}${c.toFixed(2)}% in 24h: slightly reduced size` };
}

/** Which signals qualify a token as an entry, per strategy style. */
export const STYLE_SIGNALS: Record<Settings["strategy"], string[]> = {
  balanced: ["DISCOUNT", "MOMENTUM_UP", "REBOUND"],
  momentum: ["MOMENTUM_UP"],
  value: ["DISCOUNT", "REBOUND"],
};

/** Daily-volatility-targeted size: calmer assets get bigger positions, wilder ones smaller. */
export function volTargetSize(baseUsd: number, dailyVolPct: number | null, targetDailyVolPct = 2) {
  if (!dailyVolPct || dailyVolPct <= 0) return baseUsd;
  const mult = Math.min(1.5, Math.max(0.4, targetDailyVolPct / dailyVolPct));
  return baseUsd * mult;
}

export function historyStats(prices: number[]) {
  if (prices.length < 3) return { ret30: null, dailyVol: null, drawdown: null };
  const rets = prices.slice(1).map((p, i) => Math.log(p / prices[i]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const vol = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1));
  const peak = Math.max(...prices);
  return {
    ret30: (prices[prices.length - 1] / prices[0] - 1) * 100,
    dailyVol: vol * 100,
    drawdown: (prices[prices.length - 1] / peak - 1) * 100,
  };
}

const f = (n: number | null | undefined, d = 2) => (n == null ? "n/a" : `${n >= 0 ? "+" : ""}${n.toFixed(d)}%`);

export async function runStrategy(run: AgentRun, ctx: ToolContext) {
  const s = getSettings();
  const done: string[] = [];

  // ---------- 1. read the market ----------
  const g = await globalMetrics().catch(() => null);
  const reg = regimeFrom(g?.totalMcapChange24h);
  step(run, "thinking", `Market regime: ${reg.regime}`, `${reg.why}. BTC dominance ${g?.btcDominance?.toFixed(1) ?? "?"}%. Strategy style: ${s.strategy}.`);

  // ---------- 2. review open positions ----------
  const pf = portfolioSummary();
  if (!pf.positions.length) step(run, "thinking", "No open positions to review");
  for (const p of pf.positions) {
    const row = ctx.byId.get(p.cryptoId);
    if (!row) {
      step(run, "thinking", `Hold ${p.symbol}: no fresh quote in this snapshot, leaving it to stop-loss / take-profit`);
      continue;
    }
    let reason: string | null = null;
    if (row.signals.includes("MOMENTUM_DOWN") && p.unrealizedPct < -2) reason = `momentum turned down (24h ${f(row.change24h)}) while the position is ${f(p.unrealizedPct)}`;
    else if (row.premiumPct != null && row.premiumPct > 1.5 && p.unrealizedPct > 0) reason = `harvest premium: trades ${f(row.premiumPct)} vs its peers while in profit (${f(p.unrealizedPct)})`;
    else if (reg.regime === "risk-off" && p.unrealizedPct < -4) reason = `risk-off market and position already ${f(p.unrealizedPct)}`;
    if (reason) {
      const res = toolPlaceOrder(ctx, { crypto_id: p.cryptoId, side: "sell", sell_fraction: 1, reason });
      step(run, "order", `SELL ${p.symbol}: ${res.status}${res.reject_reason ? ` (${res.reject_reason})` : ""}`, { reason, result: res });
      if (res.status === "filled") done.push(`sold ${p.symbol}`);
      else if (res.status === "pending") done.push(`proposed selling ${p.symbol}`);
    } else {
      step(run, "thinking", `Hold ${p.symbol} (${f(p.unrealizedPct)})`, `24h ${f(row.change24h)}, vs peers ${f(row.premiumPct)}, signals: ${row.signals.join(", ") || "none"}`);
    }
  }

  // ---------- 3. screen ----------
  const wanted = STYLE_SIGNALS[s.strategy].filter((x) => !(reg.regime === "risk-off" && x === "MOMENTUM_UP"));
  const held = new Set(portfolioSummary().positions.map((p) => p.cryptoId));
  const heldAssets = new Set(portfolioSummary().positions.map((p) => p.assetSymbol));
  const rejected: Record<string, number> = {};
  const reject = (why: string) => { rejected[why] = (rejected[why] ?? 0) + 1; return false; };
  const candidates = ctx.rows.filter((r) => {
    if (!r.tradable || r.vol24h < s.minVol24h) return reject("illiquid");
    if (!s.allowedTypes.includes(r.assetType)) return reject("asset type not allowed");
    if (s.avoidLeveraged && r.signals.includes("LEVERAGED")) return reject("leveraged/inverse");
    if (r.signals.includes("PREMIUM") || r.signals.includes("MOMENTUM_DOWN")) return reject("premium or falling");
    if (!r.signals.some((x) => wanted.includes(x))) return reject(`no ${s.strategy} signal`);
    if (r.score < s.minScore) return reject(`score < ${s.minScore}`);
    if (held.has(r.cryptoId) || heldAssets.has(r.assetSymbol)) return reject("already held");
    return true;
  });
  // best-priced sibling per underlying asset
  const perAsset = new Map<number, ScreenRow>();
  for (const c of candidates) {
    const cur = perAsset.get(c.rwaId);
    if (!cur || (c.premiumPct ?? 0) < (cur.premiumPct ?? 0)) perAsset.set(c.rwaId, c);
  }
  const shortlist = [...perAsset.values()].sort((a, b) => b.score - a.score).slice(0, Math.max(1, s.maxOrdersPerRun * 2));
  step(run, "thinking", `Screened ${ctx.rows.length} tokens → ${candidates.length} candidates → ${shortlist.length} shortlisted (one per asset)`,
    `Looking for: ${wanted.join(", ")}. Filtered out: ${Object.entries(rejected).map(([k, v]) => `${v} ${k}`).join(", ") || "none"}.`);
  if (shortlist.length) step(run, "info", "Shortlist", shortlist.map(compactRow));

  // ---------- 4. research + 5. size & act ----------
  for (const c of shortlist) {
    if (ctx.ordersThisRun.length >= s.maxOrdersPerRun) {
      step(run, "thinking", `Stopping: reached ${s.maxOrdersPerRun} orders for this run`);
      break;
    }
    const hist = await assetHistory(c.rwaId, "daily", 30).catch(() => []);
    const st = historyStats(hist.map((h) => h.price).filter((x) => x > 0));
    const facts = `${c.assetName}: 30d ${f(st.ret30)}, daily vol ${st.dailyVol?.toFixed(2) ?? "n/a"}%, drawdown from 30d high ${f(st.drawdown)}`;

    // falling knife: deep drawdown with no rebound signal
    if (st.drawdown != null && st.drawdown < -25 && !c.signals.includes("REBOUND")) {
      step(run, "thinking", `Skip ${c.symbol}: falling knife`, facts);
      continue;
    }
    if (st.dailyVol != null && st.dailyVol > 8) {
      step(run, "thinking", `Skip ${c.symbol}: too volatile`, facts);
      continue;
    }

    const sum = portfolioSummary();
    const base = (s.maxPositionPct / 100) * sum.equity * 0.5;
    const room = sum.cash - (s.minCashPct / 100) * sum.equity - 1;
    const size = Math.floor(Math.min(volTargetSize(base, st.dailyVol) * reg.sizeMult, (s.maxPositionPct / 100) * sum.equity * 0.95, room));
    if (size < s.minTradeUsd) {
      step(run, "thinking", `Stopping: not enough free cash for another position (would be $${Math.max(0, size)})`);
      break;
    }
    const why = c.signals.filter((x) => wanted.includes(x)).join(" + ");
    const reason = `${why}; score ${c.score}; 24h ${f(c.change24h)}, 7d ${f(c.change7d)}, vs peers ${f(c.premiumPct)}; ${facts}; size $${size} (vol-targeted, ${reg.regime})`;
    const res = toolPlaceOrder(ctx, { crypto_id: c.cryptoId, side: "buy", usd_amount: size, reason });
    step(run, "order", `BUY ${c.symbol} $${size}: ${res.status}${res.reject_reason ? ` (${res.reject_reason})` : ""}`, { reason, result: res });
    if (res.status === "filled") done.push(`bought ${c.symbol} ($${size})`);
    else if (res.status === "pending") done.push(`proposed buying ${c.symbol} ($${size})`);
  }

  const pendingNote = !s.autopilot && done.some((d) => d.startsWith("proposed")) ? " Proposals are waiting for your approval." : "";
  return done.length
    ? `${reg.regime} market, ${s.strategy} style: ${done.join("; ")}.${pendingNote}`
    : `${reg.regime} market, ${s.strategy} style: no trade met the criteria this run. Holding.`;
}
