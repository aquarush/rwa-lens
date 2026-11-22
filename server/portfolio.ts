/**
 * Paper-trading engine. No real orders are ever sent anywhere: fills are
 * simulated at the latest CMC price with a fee and a liquidity-based
 * slippage model. Every order passes the same risk checks whoever placed it
 * (the agent, the MCP server, or the user).
 */
import crypto from "node:crypto";
import type { ScreenRow } from "./screener.ts";
import { getSettings, type Settings } from "./settings.ts";
import { jsonStore } from "./store.ts";

export const FEE_RATE = 0.001; // 10 bps per fill

export interface Position {
  cryptoId: number;
  symbol: string;
  name: string;
  assetSymbol: string;
  assetType: string;
  issuerName: string | null;
  qty: number;
  avgCost: number;
  openedAt: string;
  lastPrice: number;
  lastPricedAt: string;
}

export type OrderSource = "agent" | "user" | "risk";
export type OrderStatus = "filled" | "rejected" | "pending" | "cancelled";

export interface Order {
  id: string;
  at: string;
  cryptoId: number;
  symbol: string;
  side: "buy" | "sell";
  /** requested USD notional (buys) or quantity (sells; null = close all) */
  requestedUsd: number | null;
  requestedQty: number | null;
  qty: number;
  price: number;
  notional: number;
  fee: number;
  slippageBps: number;
  realizedPnl: number;
  source: OrderSource;
  reason: string;
  status: OrderStatus;
  rejectReason?: string;
  runId?: string;
}

interface PortfolioState {
  startingCash: number;
  cash: number;
  realizedPnl: number;
  feesPaid: number;
  positions: Record<string, Position>;
  orders: Order[];
  equity: { t: string; equity: number; cash: number }[];
  createdAt: string;
}

const START = Number(process.env.PAPER_STARTING_CASH ?? 100_000);
const fresh = (): PortfolioState => ({
  startingCash: START,
  cash: START,
  realizedPnl: 0,
  feesPaid: 0,
  positions: {},
  orders: [],
  equity: [{ t: new Date().toISOString(), equity: START, cash: START }],
  createdAt: new Date().toISOString(),
});
const store = jsonStore<PortfolioState>("portfolio.json", fresh);

export function resetPortfolio(startingCash = START) {
  store.set({ ...fresh(), startingCash, cash: startingCash, equity: [{ t: new Date().toISOString(), equity: startingCash, cash: startingCash }] });
}

export function portfolioSummary() {
  const s = store.get();
  const positions = Object.values(s.positions).map((p) => {
    const value = p.qty * p.lastPrice;
    return { ...p, value, unrealizedPnl: value - p.qty * p.avgCost, unrealizedPct: p.avgCost ? (p.lastPrice / p.avgCost - 1) * 100 : 0 };
  });
  const invested = positions.reduce((a, p) => a + p.value, 0);
  const equity = s.cash + invested;
  return {
    startingCash: s.startingCash,
    cash: s.cash,
    invested,
    equity,
    totalPnl: equity - s.startingCash,
    totalPnlPct: (equity / s.startingCash - 1) * 100,
    realizedPnl: s.realizedPnl,
    unrealizedPnl: positions.reduce((a, p) => a + p.unrealizedPnl, 0),
    feesPaid: s.feesPaid,
    grossExposurePct: equity ? (invested / equity) * 100 : 0,
    positions: positions.sort((a, b) => b.value - a.value),
    pending: s.orders.filter((o) => o.status === "pending"),
    createdAt: s.createdAt,
  };
}

export const orderHistory = (limit = 200) => store.get().orders.slice(-limit).reverse();
export const equityHistory = () => store.get().equity;

/** Simple impact model: 5 bps base + 10 bps per 1% of 24h volume, capped at 2%. */
export function slippageBps(notional: number, vol24h: number) {
  const share = vol24h > 0 ? notional / vol24h : 1;
  return Math.min(200, 5 + share * 1000);
}

export interface OrderRequest {
  cryptoId: number;
  side: "buy" | "sell";
  usd?: number | null;
  qty?: number | null;
  reason: string;
  source: OrderSource;
  runId?: string;
}

/** Risk checks. Returns a reason string when the order must be rejected. */
export function riskCheck(req: OrderRequest, row: ScreenRow | undefined, settings: Settings): string | null {
  const s = store.get();
  const pos = s.positions[req.cryptoId];
  if (req.source !== "risk" && settings.killSwitch) return "kill switch is on";
  if (req.side === "sell") {
    if (!pos || pos.qty <= 0) return "no open position to sell";
    return null;
  }
  if (!row) return "token not in the current screener universe (no live quote)";
  const sum = portfolioSummary();
  const usd = req.usd ?? 0;
  if (!(usd > 0)) return "buy requires a positive usd amount";
  if (usd < settings.minTradeUsd) return `below minimum trade size $${settings.minTradeUsd}`;
  if (!settings.allowedTypes.includes(row.assetType)) return `asset type ${row.assetType} is not allowed`;
  if (settings.blockedSymbols.map((x) => x.toLowerCase()).includes(row.symbol.toLowerCase())) return `${row.symbol} is blocked`;
  if (settings.avoidLeveraged && row.signals?.includes("LEVERAGED")) return `${row.symbol} tracks a leveraged/inverse product (avoidLeveraged is on)`;
  if (row.vol24h < settings.minVol24h) return `24h volume $${Math.round(row.vol24h)} below minimum $${settings.minVol24h}`;
  if (row.premiumPct != null && row.premiumPct > settings.maxBuyPremiumPct)
    return `trading at ${row.premiumPct.toFixed(2)}% premium to its asset reference (max ${settings.maxBuyPremiumPct}%)`;
  const cost = usd * (1 + FEE_RATE);
  const minCash = (settings.minCashPct / 100) * sum.equity;
  if (sum.cash - cost < minCash) return `would breach the ${settings.minCashPct}% cash floor (cash $${sum.cash.toFixed(0)})`;
  const posValue = pos ? pos.qty * row.price : 0;
  if (posValue + usd > (settings.maxPositionPct / 100) * sum.equity)
    return `position would exceed ${settings.maxPositionPct}% of equity`;
  if (sum.invested + usd > (settings.maxGrossExposurePct / 100) * sum.equity)
    return `gross exposure would exceed ${settings.maxGrossExposurePct}%`;
  return null;
}

function fill(req: OrderRequest, row: ScreenRow | undefined, base: Partial<Order>): Order {
  const s = store.get();
  const pos = s.positions[req.cryptoId];
  const price0 = row?.price ?? pos?.lastPrice ?? 0;
  const vol = row?.vol24h ?? 0;
  const now = new Date().toISOString();

  if (req.side === "buy") {
    const usd = req.usd!;
    const slip = slippageBps(usd, vol);
    const price = price0 * (1 + slip / 10_000);
    const qty = usd / price;
    const fee = usd * FEE_RATE;
    s.cash -= usd + fee;
    s.feesPaid += fee;
    if (pos) {
      pos.avgCost = (pos.avgCost * pos.qty + price * qty) / (pos.qty + qty);
      pos.qty += qty;
      pos.lastPrice = price0;
      pos.lastPricedAt = now;
    } else {
      s.positions[req.cryptoId] = {
        cryptoId: req.cryptoId, symbol: row!.symbol, name: row!.name, assetSymbol: row!.assetSymbol, assetType: row!.assetType,
        issuerName: row!.issuerName, qty, avgCost: price, openedAt: now, lastPrice: price0, lastPricedAt: now,
      };
    }
    return { ...base, status: "filled", qty, price, notional: usd, fee, slippageBps: slip, realizedPnl: 0 } as Order;
  }

  // sell
  const qty = Math.min(pos!.qty, req.qty ?? (req.usd ? req.usd / price0 : pos!.qty));
  const notional0 = qty * price0;
  const slip = slippageBps(notional0, vol);
  const price = price0 * (1 - slip / 10_000);
  const notional = qty * price;
  const fee = notional * FEE_RATE;
  const realized = (price - pos!.avgCost) * qty - fee;
  s.cash += notional - fee;
  s.feesPaid += fee;
  s.realizedPnl += realized;
  pos!.qty -= qty;
  if (pos!.qty * price0 < 1) delete s.positions[req.cryptoId];
  return { ...base, status: "filled", qty, price, notional, fee, slippageBps: slip, realizedPnl: realized } as Order;
}

/**
 * Place a paper order. With `pending: true` (autopilot off) the order is only
 * validated and queued for approval.
 */
export function placeOrder(req: OrderRequest, row: ScreenRow | undefined, opts: { pending?: boolean } = {}): Order {
  const settings = getSettings();
  const s = store.get();
  const pos = s.positions[req.cryptoId];
  const base: Order = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    cryptoId: req.cryptoId,
    symbol: row?.symbol ?? pos?.symbol ?? String(req.cryptoId),
    side: req.side,
    requestedUsd: req.usd ?? null,
    requestedQty: req.qty ?? null,
    qty: 0, price: row?.price ?? pos?.lastPrice ?? 0, notional: 0, fee: 0, slippageBps: 0, realizedPnl: 0,
    source: req.source,
    reason: req.reason,
    status: "rejected",
    runId: req.runId,
  };
  const reject = riskCheck(req, row, settings);
  let order: Order;
  if (reject) order = { ...base, rejectReason: reject };
  else if (opts.pending) order = { ...base, status: "pending" };
  else order = fill(req, row, base);
  s.orders.push(order);
  if (s.orders.length > 2000) s.orders.splice(0, s.orders.length - 2000);
  store.set(s);
  return order;
}

export function approvePending(orderId: string, rows: Map<number, ScreenRow>): Order {
  const s = store.get();
  const o = s.orders.find((x) => x.id === orderId);
  if (!o || o.status !== "pending") throw new Error("no such pending order");
  o.status = "cancelled";
  o.rejectReason = "superseded by approval fill";
  store.set(s);
  // re-validate and fill at the current price
  return placeOrder(
    { cryptoId: o.cryptoId, side: o.side, usd: o.requestedUsd, qty: o.requestedQty, reason: `${o.reason} (approved by user)`, source: "user", runId: o.runId },
    rows.get(o.cryptoId),
  );
}

export function cancelPending(orderId: string) {
  store.update((s) => {
    const o = s.orders.find((x) => x.id === orderId);
    if (o && o.status === "pending") {
      o.status = "cancelled";
      o.rejectReason = "cancelled by user";
    }
  });
}

/**
 * Re-price positions from the latest screener rows, record an equity point,
 * and fire stop-loss / take-profit exits. Returns any exit orders placed.
 */
export function markToMarket(rows: Map<number, ScreenRow>): Order[] {
  const settings = getSettings();
  const s = store.get();
  const now = new Date().toISOString();
  for (const p of Object.values(s.positions)) {
    const r = rows.get(p.cryptoId);
    if (r) {
      p.lastPrice = r.price;
      p.lastPricedAt = now;
    }
  }
  store.set(s);

  const exits: Order[] = [];
  for (const p of Object.values(store.get().positions)) {
    const chg = (p.lastPrice / p.avgCost - 1) * 100;
    let reason: string | null = null;
    if (settings.stopLossPct > 0 && chg <= -settings.stopLossPct) reason = `stop-loss: ${chg.toFixed(2)}% vs limit -${settings.stopLossPct}%`;
    else if (settings.takeProfitPct > 0 && chg >= settings.takeProfitPct) reason = `take-profit: +${chg.toFixed(2)}% vs target ${settings.takeProfitPct}%`;
    if (reason) exits.push(placeOrder({ cryptoId: p.cryptoId, side: "sell", reason, source: "risk" }, rows.get(p.cryptoId)));
  }

  const sum = portfolioSummary();
  store.update((st) => {
    const last = st.equity[st.equity.length - 1];
    // keep at most one point per 5 minutes
    if (last && st.equity.length > 1 && Date.now() - Date.parse(last.t) < 5 * 60_000) st.equity[st.equity.length - 1] = { t: now, equity: sum.equity, cash: sum.cash };
    else st.equity.push({ t: now, equity: sum.equity, cash: sum.cash });
    if (st.equity.length > 5000) st.equity.splice(0, st.equity.length - 5000);
  });
  return exits;
}
