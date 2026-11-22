/**
 * Core logic tests. Run with `npm test`. They use a throwaway DATA_DIR and
 * force mock mode, so they never touch your real portfolio or spend credits.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rwa-lens-test-"));
process.env.CMC_API_KEY = "";

const { scoreTokens } = await import("../server/screener.ts");
const portfolio = await import("../server/portfolio.ts");
const { updateSettings, DEFAULT_SETTINGS } = await import("../server/settings.ts");
const { mockResponse } = await import("../server/mock.ts");
type RwaToken = import("../server/rwa.ts").RwaToken;

const tok = (o: Partial<RwaToken> & { cryptoId: number; price: number }): RwaToken => ({
  symbol: `T${o.cryptoId}`, name: "t", mcap: 10_000_000, vol24h: 5_000_000, issuerId: null, issuerName: "X", rwaId: 1,
  assetName: "Asset", assetSymbol: "AST", assetType: "stock", assetAvgPrice: null,
  change1h: 0, change24h: 0, change7d: 0, change30d: 0, ...o,
});

test("premium is measured against siblings, excluding the token itself", () => {
  const rows = scoreTokens([
    tok({ cryptoId: 1, price: 100, vol24h: 50_000_000 }),
    tok({ cryptoId: 2, price: 101 }),
    tok({ cryptoId: 3, price: 98 }),
  ]);
  const byId = new Map(rows.map((r) => [r.cryptoId, r]));
  // the dominant-volume token is no longer pinned to 0%
  assert.notEqual(byId.get(1)!.premiumPct, 0);
  // token 3 at 98 vs siblings (100 dominant) is at a ~2% discount
  assert.ok(Math.abs(byId.get(3)!.premiumPct! - -2) < 0.01);
  assert.ok(byId.get(3)!.signals.includes("DISCOUNT"));
  assert.ok(byId.get(2)!.signals.includes("PREMIUM"));
});

test("tokens quoted in a different unit are flagged, not called a de-peg", () => {
  // live data: SNDK tokens at ~$82 plus two at ~$655 (different unit)
  const rows = scoreTokens([
    tok({ cryptoId: 1, price: 82.6, vol24h: 16e6 }),
    tok({ cryptoId: 2, price: 82.5, vol24h: 10e6 }),
    tok({ cryptoId: 3, price: 654.9, vol24h: 0.26e6 }),
  ]);
  const odd = rows.find((r) => r.cryptoId === 3)!;
  assert.equal(odd.premiumPct, null);
  assert.ok(odd.signals.includes("UNIT_MISMATCH"));
  assert.ok(Math.abs(rows.find((r) => r.cryptoId === 1)!.premiumPct!) < 0.2);
});

test("single token with no siblings has no premium", () => {
  const [r] = scoreTokens([tok({ cryptoId: 9, price: 5 })]);
  assert.equal(r.premiumPct, null);
  assert.equal(r.peers, 0);
});

test("leveraged ETFs are flagged and blocked by the risk engine", () => {
  updateSettings({ ...DEFAULT_SETTINGS });
  const [r] = scoreTokens([tok({ cryptoId: 50, price: 33, assetSymbol: "SOXL", assetName: "Direxion Semiconductor Bull 3X", assetType: "etf" })]);
  assert.ok(r.signals.includes("LEVERAGED"));
  const o = portfolio.placeOrder({ cryptoId: 50, side: "buy", usd: 1000, reason: "t", source: "agent" }, r);
  assert.equal(o.status, "rejected");
  assert.match(o.rejectReason!, /leveraged/);
});

test("paper fills apply fee and slippage, and enforce position limits", () => {
  portfolio.resetPortfolio(100_000);
  updateSettings({ ...DEFAULT_SETTINGS });
  const [row] = scoreTokens([tok({ cryptoId: 7, price: 100, vol24h: 10_000_000 }), tok({ cryptoId: 8, price: 100 })]);
  const buy = portfolio.placeOrder({ cryptoId: 7, side: "buy", usd: 10_000, reason: "t", source: "user" }, row);
  assert.equal(buy.status, "filled");
  assert.ok(buy.price > 100, "buy fills above mid due to slippage");
  assert.equal(buy.fee, 10);
  const s = portfolio.portfolioSummary();
  assert.ok(Math.abs(s.cash - (100_000 - 10_010)) < 1e-6);

  const tooBig = portfolio.placeOrder({ cryptoId: 7, side: "buy", usd: 15_000, reason: "t", source: "agent" }, row);
  assert.equal(tooBig.status, "rejected");
  assert.match(tooBig.rejectReason!, /20% of equity/);

  const sell = portfolio.placeOrder({ cryptoId: 7, side: "sell", reason: "t", source: "user" }, row);
  assert.equal(sell.status, "filled");
  assert.ok(sell.realizedPnl < 0, "round trip at an unchanged mid loses fees + slippage");
  assert.equal(portfolio.portfolioSummary().positions.length, 0);
});

test("pending orders wait for approval and re-validate on approve", () => {
  portfolio.resetPortfolio(100_000);
  const rows = scoreTokens([tok({ cryptoId: 11, price: 50 }), tok({ cryptoId: 12, price: 50 })]);
  const p = portfolio.placeOrder({ cryptoId: 11, side: "buy", usd: 5_000, reason: "t", source: "agent" }, rows[0], { pending: true });
  assert.equal(p.status, "pending");
  assert.equal(portfolio.portfolioSummary().cash, 100_000);
  const filled = portfolio.approvePending(p.id, new Map(rows.map((r) => [r.cryptoId, r])));
  assert.equal(filled.status, "filled");
  assert.equal(portfolio.portfolioSummary().pending.length, 0);
});

test("stop-loss fires on mark-to-market", () => {
  portfolio.resetPortfolio(100_000);
  updateSettings({ ...DEFAULT_SETTINGS, stopLossPct: 5 });
  const rows = scoreTokens([tok({ cryptoId: 21, price: 100 }), tok({ cryptoId: 22, price: 100 })]);
  portfolio.placeOrder({ cryptoId: 21, side: "buy", usd: 5_000, reason: "t", source: "user" }, rows[0]);
  const crashed = { ...rows[0], price: 90 };
  const exits = portfolio.markToMarket(new Map([[21, crashed]]));
  assert.equal(exits.length, 1);
  assert.equal(exits[0].source, "risk");
  assert.match(exits[0].reason, /stop-loss/);
});

test("kill switch blocks agent and user orders", () => {
  portfolio.resetPortfolio(100_000);
  updateSettings({ ...DEFAULT_SETTINGS, killSwitch: true });
  const [row] = scoreTokens([tok({ cryptoId: 31, price: 10 }), tok({ cryptoId: 32, price: 10 })]);
  const o = portfolio.placeOrder({ cryptoId: 31, side: "buy", usd: 1_000, reason: "t", source: "user" }, row);
  assert.equal(o.status, "rejected");
  assert.match(o.rejectReason!, /kill switch/);
  updateSettings({ ...DEFAULT_SETTINGS });
});

test("mock layer answers every endpoint the app uses in the documented shape", () => {
  const list = mockResponse("/v5/real-world-assets/assets/list", { limit: "5" }) as any;
  assert.ok(Array.isArray(list.data.rwa_assets) && list.data.rwa_assets.length > 0);
  const q = mockResponse("/v5/real-world-assets/quotes/latest", { rwa_id: "1" }) as any;
  assert.ok(q.data.rwa_assets[0].tokens.length > 0);
  const ids = q.data.rwa_assets[0].tokens.map((t: any) => t.crypto_id).join(",");
  const cq = mockResponse("/v2/cryptocurrency/quotes/latest", { id: ids }) as any;
  assert.ok(Object.values(cq.data).every((v: any) => typeof v.quote.USD.percent_change_24h === "number"));
  const h = mockResponse("/v5/real-world-assets/quotes/historical", { rwa_id: "1", count: "30", interval: "daily" }) as any;
  assert.equal(h.data.rwa_assets[0].quotes.length, 30);
  assert.ok(mockResponse("/v1/global-metrics/quotes/latest", {}));
});

test("agent: market regime scales sizing and blocks momentum buys when risk-off", async () => {
  const { regimeFrom, STYLE_SIGNALS } = await import("../server/agent/strategy.ts");
  assert.equal(regimeFrom(-4).regime, "risk-off");
  assert.equal(regimeFrom(-4).sizeMult, 0.5);
  assert.equal(regimeFrom(3).regime, "risk-on");
  assert.equal(regimeFrom(0.3).regime, "neutral");
  assert.equal(regimeFrom(null).regime, "neutral");
  assert.deepEqual(STYLE_SIGNALS.value, ["DISCOUNT", "REBOUND"]);
});

test("agent: volatility-targeted sizing and 30-day history stats", async () => {
  const { volTargetSize, historyStats } = await import("../server/agent/strategy.ts");
  assert.equal(volTargetSize(10_000, 2), 10_000); // at target
  assert.equal(volTargetSize(10_000, 4), 5_000); // twice as volatile -> half size
  assert.equal(volTargetSize(10_000, 0.5), 15_000); // capped at 1.5x
  assert.equal(volTargetSize(10_000, 20), 4_000); // floored at 0.4x
  assert.equal(volTargetSize(10_000, null), 10_000);
  const st = historyStats([100, 110, 99, 120, 90]);
  assert.ok(Math.abs(st.ret30! - -10) < 1e-9);
  assert.ok(Math.abs(st.drawdown! - -25) < 1e-9);
  assert.ok(st.dailyVol! > 0);
  assert.equal(historyStats([1, 2]).dailyVol, null);
});
