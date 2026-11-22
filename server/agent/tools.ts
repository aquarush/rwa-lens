/**
 * Trading tools shared by both engines (Claude tool use and the rule-based
 * strategy) and by the MCP server. Each returns plain JSON-able data.
 */
import { assetHistory, marketPairs } from "../rwa.ts";
import { filterRows, marketOverview, type ScreenRow, type Signal } from "../screener.ts";
import { placeOrder, portfolioSummary, type Order } from "../portfolio.ts";
import { getSettings } from "../settings.ts";
import type { AssetType } from "../rwa.ts";

const r2 = (n: number | null | undefined, d = 2) => (n == null ? null : Number(n.toFixed(d)));

/** Compact row for LLM context: everything needed to decide, nothing else. */
export function compactRow(r: ScreenRow) {
  return {
    crypto_id: r.cryptoId,
    symbol: r.symbol,
    name: r.name,
    issuer: r.issuerName,
    asset: `${r.assetName} (${r.assetSymbol}, ${r.assetType})`,
    price: r2(r.price, r.price < 10 ? 4 : 2),
    premium_pct: r2(r.premiumPct, 3),
    peer_ref_price: r2(r.refPrice, r.price < 10 ? 4 : 2),
    change_1h_pct: r2(r.change1h),
    change_24h_pct: r2(r.change24h),
    change_7d_pct: r2(r.change7d),
    change_30d_pct: r2(r.change30d),
    mcap_usd: Math.round(r.mcap),
    vol_24h_usd: Math.round(r.vol24h),
    turnover: r2(r.turnover, 3),
    score: r.score,
    signals: r.signals,
  };
}

export interface ToolContext {
  rows: ScreenRow[];
  byId: Map<number, ScreenRow>;
  runId: string;
  pending: boolean;
  ordersThisRun: Order[];
}

export async function toolMarketOverview() {
  const m = await marketOverview();
  return {
    rwa_tokenized_mcap_usd_top_assets: Math.round(m.rwa.tokenizedMcap),
    rwa_volume_24h_usd: Math.round(m.rwa.vol24h),
    crypto_total_mcap_usd: Math.round(m.crypto.totalMcap),
    crypto_mcap_change_24h_pct: r2(m.crypto.totalMcapChange24h),
    btc_dominance_pct: r2(m.crypto.btcDominance),
    rwa_share_of_crypto_pct: r2(m.rwaSharePct, 3),
    by_asset_type: m.byType.map((t) => ({ type: t.type, mcap_usd: Math.round(t.mcap), vol_24h_usd: Math.round(t.vol24h), assets: t.assets })),
    tokens_deviating_1pct_or_more: m.depegCount,
  };
}

export function toolScreen(ctx: ToolContext, f: { asset_type?: AssetType; signal?: Signal; min_vol_24h?: number; query?: string; sort?: "score" | "change24h" | "change7d" | "premiumPct" | "vol24h" | "mcap"; direction?: "asc" | "desc"; limit?: number }) {
  const rows = filterRows(ctx.rows, {
    assetType: f.asset_type,
    signal: f.signal,
    minVol: f.min_vol_24h ?? getSettings().minVol24h,
    q: f.query,
    sort: f.sort ?? "score",
    dir: f.direction ?? "desc",
    limit: Math.min(f.limit ?? 15, 30),
  });
  return { count: rows.length, tokens: rows.map(compactRow) };
}

export async function toolTokenDetail(ctx: ToolContext, cryptoId: number) {
  const row = ctx.byId.get(cryptoId);
  if (!row) return { error: `crypto_id ${cryptoId} is not in the current universe` };
  type Hist = Awaited<ReturnType<typeof assetHistory>>;
  type Pairs = Awaited<ReturnType<typeof marketPairs>>;
  let pairsNote: string | null = null;
  const [hist, pairs] = await Promise.all([
    assetHistory(row.rwaId, "daily", 30).catch((): Hist => []),
    marketPairs(row.rwaId).catch((err: Error): Pairs => {
      pairsNote = err.message;
      return [];
    }),
  ]);
  const prices = hist.map((h) => h.price).filter((x) => x > 0);
  const rets = prices.slice(1).map((p, i) => Math.log(p / prices[i]));
  const mean = rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length);
  const vol = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1));
  const peak = Math.max(...prices);
  return {
    token: compactRow(row),
    siblings_tracking_same_asset: ctx.rows.filter((x) => x.rwaId === row.rwaId && x.cryptoId !== row.cryptoId).slice(0, 8).map((x) => ({
      crypto_id: x.cryptoId, symbol: x.symbol, issuer: x.issuerName, price: x.price, premium_pct: r2(x.premiumPct, 3), vol_24h_usd: Math.round(x.vol24h),
    })),
    asset_history_30d: {
      points: prices.length,
      first: r2(prices[0]),
      last: r2(prices[prices.length - 1]),
      return_pct: prices.length > 1 ? r2((prices[prices.length - 1] / prices[0] - 1) * 100) : null,
      daily_volatility_pct: rets.length > 2 ? r2(vol * 100) : null,
      drawdown_from_30d_high_pct: prices.length ? r2((prices[prices.length - 1] / peak - 1) * 100) : null,
      last_7_closes: prices.slice(-7).map((p) => r2(p)),
    },
    market_pairs_note: pairsNote ?? undefined,
    top_market_pairs: pairs.slice(0, 6).map((p) => ({ exchange: p.exchange, pair: p.pair, price: p.price, vol_24h_usd: Math.round(p.vol24h) })),
  };
}

export function toolPortfolio() {
  const p = portfolioSummary();
  const s = getSettings();
  return {
    equity_usd: r2(p.equity),
    cash_usd: r2(p.cash),
    total_pnl_pct: r2(p.totalPnlPct),
    gross_exposure_pct: r2(p.grossExposurePct),
    positions: p.positions.map((x) => ({
      crypto_id: x.cryptoId, symbol: x.symbol, asset: x.assetSymbol, qty: Number(x.qty.toPrecision(6)), avg_cost: r2(x.avgCost, 4),
      last_price: r2(x.lastPrice, 4), value_usd: r2(x.value), unrealized_pct: r2(x.unrealizedPct), opened_at: x.openedAt,
    })),
    pending_orders: p.pending.map((o) => ({ symbol: o.symbol, side: o.side, usd: o.requestedUsd, reason: o.reason })),
    limits: {
      max_position_pct_of_equity: s.maxPositionPct,
      max_gross_exposure_pct: s.maxGrossExposurePct,
      min_cash_pct: s.minCashPct,
      min_trade_usd: s.minTradeUsd,
      max_orders_per_run: s.maxOrdersPerRun,
      min_vol_24h_usd: s.minVol24h,
      max_buy_premium_pct: s.maxBuyPremiumPct,
      stop_loss_pct: s.stopLossPct,
      take_profit_pct: s.takeProfitPct,
      allowed_asset_types: s.allowedTypes,
    },
  };
}

export function toolPlaceOrder(ctx: ToolContext, input: { crypto_id: number; side: "buy" | "sell"; usd_amount?: number; sell_fraction?: number; reason: string }) {
  const s = getSettings();
  if (ctx.ordersThisRun.length >= s.maxOrdersPerRun) return { status: "rejected", reject_reason: `max ${s.maxOrdersPerRun} orders per run reached` };
  let qty: number | null = null;
  if (input.side === "sell") {
    const pos = portfolioSummary().positions.find((p) => p.cryptoId === input.crypto_id);
    const frac = Math.min(1, Math.max(0, input.sell_fraction ?? 1));
    qty = pos ? pos.qty * frac : null;
  }
  const order = placeOrder(
    { cryptoId: input.crypto_id, side: input.side, usd: input.side === "buy" ? input.usd_amount : null, qty, reason: input.reason, source: "agent", runId: ctx.runId },
    ctx.byId.get(input.crypto_id),
    { pending: ctx.pending },
  );
  if (order.status !== "rejected") ctx.ordersThisRun.push(order);
  return {
    status: order.status,
    reject_reason: order.rejectReason,
    symbol: order.symbol,
    side: order.side,
    fill_price: order.status === "filled" ? r2(order.price, 4) : undefined,
    notional_usd: order.status === "filled" ? r2(order.notional) : order.requestedUsd,
    slippage_bps: order.status === "filled" ? r2(order.slippageBps, 1) : undefined,
    note: order.status === "pending" ? "Autopilot is off: the order is queued for the user to approve." : undefined,
    order_id: order.id,
  };
}
