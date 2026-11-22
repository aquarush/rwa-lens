/**
 * Rule-based engine: a transparent, deterministic strategy used when no
 * Anthropic credentials are configured (or when the user picks it). It uses
 * the same tools, so its orders pass the same risk checks.
 *
 * Exits:  momentum turned down while under water, or token now rich (>1.5% premium).
 * Entries: liquid, high-score tokens with DISCOUNT / MOMENTUM_UP / REBOUND and no
 *          PREMIUM; one new token per underlying asset; best-priced sibling wins.
 */
import { portfolioSummary } from "../portfolio.ts";
import { getSettings } from "../settings.ts";
import { step, type AgentRun } from "./journal.ts";
import { compactRow, toolPlaceOrder, type ToolContext } from "./tools.ts";

export function runRules(run: AgentRun, ctx: ToolContext) {
  const s = getSettings();
  const pf = portfolioSummary();
  const notes: string[] = [];

  // ---- exits ----
  for (const p of pf.positions) {
    const row = ctx.byId.get(p.cryptoId);
    if (!row) continue;
    let reason: string | null = null;
    if (row.signals.includes("MOMENTUM_DOWN") && p.unrealizedPct < -2) reason = `momentum turned down (24h ${row.change24h?.toFixed(2)}%) with position at ${p.unrealizedPct.toFixed(2)}%`;
    else if (row.premiumPct != null && row.premiumPct > 1.5 && p.unrealizedPct > 0) reason = `harvest premium: trades ${row.premiumPct.toFixed(2)}% above its asset reference`;
    if (reason) {
      const res = toolPlaceOrder(ctx, { crypto_id: p.cryptoId, side: "sell", sell_fraction: 1, reason });
      step(run, "order", `SELL ${p.symbol}: ${res.status}${res.reject_reason ? ` (${res.reject_reason})` : ""}`, { reason, result: res });
      if (res.status === "filled") notes.push(`sold ${p.symbol} (${reason})`);
      else if (res.status === "pending") notes.push(`proposed selling ${p.symbol} (${reason}), awaiting approval`);
    }
  }

  // ---- entries ----
  const held = new Set(portfolioSummary().positions.map((p) => p.cryptoId));
  const heldAssets = new Set(portfolioSummary().positions.map((p) => p.assetSymbol));
  const candidates = ctx.rows
    .filter((r) => r.tradable && r.vol24h >= s.minVol24h && s.allowedTypes.includes(r.assetType))
    .filter((r) => !r.signals.includes("PREMIUM") && !r.signals.includes("MOMENTUM_DOWN"))
    .filter((r) => !(s.avoidLeveraged && r.signals.includes("LEVERAGED")))
    .filter((r) => r.signals.some((x) => x === "DISCOUNT" || x === "MOMENTUM_UP" || x === "REBOUND"))
    .filter((r) => r.score >= 55 && !held.has(r.cryptoId) && !heldAssets.has(r.assetSymbol))
    .sort((a, b) => b.score - a.score);

  // keep only the best-priced (lowest premium) sibling per asset
  const perAsset = new Map<number, (typeof candidates)[number]>();
  for (const c of candidates) {
    const cur = perAsset.get(c.rwaId);
    if (!cur || (c.premiumPct ?? 0) < (cur.premiumPct ?? 0)) perAsset.set(c.rwaId, c);
  }
  const picks = [...perAsset.values()].sort((a, b) => b.score - a.score);
  step(run, "info", `Screened ${ctx.rows.length} tokens, ${candidates.length} candidates, ${picks.length} distinct assets`, picks.slice(0, 8).map(compactRow));

  for (const c of picks) {
    if (ctx.ordersThisRun.length >= s.maxOrdersPerRun) break;
    const sum = portfolioSummary();
    // half of the max position size, leaving room to add later
    const size = Math.floor(Math.min((s.maxPositionPct / 100) * sum.equity * 0.5, sum.cash - (s.minCashPct / 100) * sum.equity - 1));
    if (size < s.minTradeUsd) break;
    const why = c.signals.filter((x) => x !== "ILLIQUID").join(", ");
    const reason = `score ${c.score}; ${why}; 24h ${c.change24h?.toFixed(2) ?? "?"}%, 7d ${c.change7d?.toFixed(2) ?? "?"}%, vs peers ${c.premiumPct != null ? `${c.premiumPct.toFixed(2)}%` : "n/a"}`;
    const res = toolPlaceOrder(ctx, { crypto_id: c.cryptoId, side: "buy", usd_amount: size, reason });
    step(run, "order", `BUY ${c.symbol} $${size}: ${res.status}${res.reject_reason ? ` (${res.reject_reason})` : ""}`, { reason, result: res });
    if (res.status === "filled") notes.push(`bought ${c.symbol} ($${size})`);
    else if (res.status === "pending") notes.push(`proposed buying ${c.symbol} ($${size}), awaiting approval`);
  }

  return notes.length ? `Rule engine: ${notes.join("; ")}.` : "Rule engine: no trades met the entry/exit criteria this run.";
}
