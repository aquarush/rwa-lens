import { isCurrent } from "../main";
import { ago, api, esc, lineChart, modal, pct, signedUsd, toast, usd } from "../lib";
import { openTrade } from "../trade";

export async function renderPortfolio(app: HTMLElement, token: number) {
  const [pf, eq, orders] = await Promise.all([api("/api/portfolio"), api<any[]>("/api/equity"), api<any[]>("/api/orders?limit=150")]);
  if (!isCurrent(token)) return;

  app.innerHTML = `
    <div class="spread"><div><h1>Paper portfolio</h1><p class="sub">Simulated trading at live CMC prices: 10 bps fee plus size-based slippage. No real orders are sent.</p></div>
      <div class="row"><button id="refresh">Re-price now</button><button class="danger" id="reset">Reset…</button></div></div>
    <div class="tiles">
      <div class="card tile"><div class="label">Equity</div><div class="value">${usd(pf.equity, { dp: 0 })}</div><div class="delta">${pct(pf.totalPnlPct)} since start</div></div>
      <div class="card tile"><div class="label">Cash</div><div class="value">${usd(pf.cash, { dp: 0 })}</div><div class="delta muted">${(100 - pf.grossExposurePct).toFixed(1)}% of equity</div></div>
      <div class="card tile"><div class="label">Invested</div><div class="value">${usd(pf.invested, { dp: 0 })}</div><div class="delta muted">${pf.positions.length} positions</div></div>
      <div class="card tile"><div class="label">Unrealized P&L</div><div class="value">${signedUsd(pf.unrealizedPnl)}</div></div>
      <div class="card tile"><div class="label">Realized P&L</div><div class="value">${signedUsd(pf.realizedPnl)}</div><div class="delta muted">fees ${usd(pf.feesPaid)}</div></div>
    </div>
    <div class="card"><h2>Equity over time</h2><div class="chart-box">${eq.length > 1 ? `<canvas id="eq"></canvas>` : `<div class="empty">No history yet.</div>`}</div></div>
    <div class="card" style="margin-top:16px"><h2>Positions</h2>
      ${pf.positions.length ? `<div class="table-wrap"><table><thead><tr><th>Token</th><th>Asset</th><th class="num">Qty</th><th class="num hide-sm">Avg cost</th><th class="num">Last</th><th class="num">Value</th><th class="num">Unrealized</th><th class="hide-sm">Opened</th><th></th></tr></thead><tbody>
      ${pf.positions.map((p: any, i: number) => `<tr><td><span class="sym">${esc(p.symbol)}</span><div class="small muted">${esc(p.issuerName ?? "")}</div></td><td>${esc(p.assetSymbol)}</td><td class="num">${Number(p.qty.toPrecision(6))}</td><td class="num hide-sm">${usd(p.avgCost)}</td><td class="num">${usd(p.lastPrice)}<div class="small muted">${ago(p.lastPricedAt)}</div></td><td class="num">${usd(p.value)}</td><td class="num">${signedUsd(p.unrealizedPnl)}<div class="small">${pct(p.unrealizedPct)}</div></td><td class="small muted hide-sm">${ago(p.openedAt)}</td>
        <td class="row" style="flex-wrap:nowrap"><button class="sm" data-buy="${i}">Add</button><button class="sm" data-sell="${i}">Sell</button></td></tr>`).join("")}
      </tbody></table></div>` : `<div class="empty">No open positions. Run the agent or trade from the <a href="#/screener">screener</a>.</div>`}
    </div>
    <div class="card" style="margin-top:16px"><h2>Order history</h2>
      ${orders.length ? `<div class="table-wrap"><table><thead><tr><th>Time</th><th class="hide-sm">Source</th><th>Side</th><th>Token</th><th class="num">Notional</th><th class="num">Price</th><th class="num hide-sm">Slip</th><th class="num">Realized</th><th>Status</th><th class="hide-sm">Reason</th></tr></thead><tbody>
      ${orders.map((o) => `<tr><td class="small muted">${new Date(o.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td><td class="small hide-sm">${esc(o.source)}</td><td><b>${o.side.toUpperCase()}</b></td><td class="sym">${esc(o.symbol)}</td><td class="num">${o.status === "filled" ? usd(o.notional) : o.requestedUsd ? usd(o.requestedUsd) : "—"}</td><td class="num">${o.status === "filled" ? usd(o.price) : "—"}</td><td class="num small hide-sm">${o.status === "filled" ? `${o.slippageBps.toFixed(1)} bps` : ""}</td><td class="num">${o.side === "sell" && o.status === "filled" ? signedUsd(o.realizedPnl) : ""}</td><td class="small ${o.status === "rejected" ? "down" : ""}">${esc(o.status)}${o.rejectReason && o.status === "rejected" ? `<div class="muted">${esc(o.rejectReason)}</div>` : ""}</td><td class="small hide-sm">${esc(o.reason)}</td></tr>`).join("")}
      </tbody></table></div>` : `<div class="empty">No orders yet.</div>`}
    </div>`;

  if (eq.length > 1) lineChart(app.querySelector("#eq")!, eq.map((p) => new Date(p.t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })), eq.map((p) => p.equity), (v) => usd(v, { dp: 0 }), { fill: false });
  const rerender = () => renderPortfolio(app, token);
  app.querySelectorAll<HTMLElement>("[data-sell]").forEach((b) => b.addEventListener("click", () => openTrade(toTrade(pf.positions[Number(b.dataset.sell)]), "sell", rerender)));
  app.querySelectorAll<HTMLElement>("[data-buy]").forEach((b) => b.addEventListener("click", () => openTrade(toTrade(pf.positions[Number(b.dataset.buy)]), "buy", rerender)));
  app.querySelector("#refresh")!.addEventListener("click", async () => {
    try { await api("/api/portfolio/refresh", { method: "POST" }); toast("Positions re-priced"); rerender(); } catch (err) { toast((err as Error).message, true); }
  });
  app.querySelector("#reset")!.addEventListener("click", () => modal(
    `<h2>Reset paper portfolio?</h2><p class="muted">This clears all positions, orders and equity history.</p><label class="field">Starting cash (USD)<input id="cash" type="number" value="${pf.startingCash}"/></label><div class="row" style="justify-content:flex-end;margin-top:14px"><button id="no">Cancel</button><button class="primary" id="yes">Reset</button></div>`,
    (root, close) => {
      root.querySelector("#no")!.addEventListener("click", close);
      root.querySelector("#yes")!.addEventListener("click", async () => {
        try { await api("/api/portfolio/reset", { method: "POST", json: { startingCash: Number((root.querySelector("#cash") as HTMLInputElement).value) } }); close(); toast("Portfolio reset"); rerender(); } catch (err) { toast((err as Error).message, true); }
      });
    },
  ));
}

const toTrade = (p: any) => ({ cryptoId: p.cryptoId, symbol: p.symbol, name: p.name, price: p.lastPrice, issuerName: p.issuerName });
