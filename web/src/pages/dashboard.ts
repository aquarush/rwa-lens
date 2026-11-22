import { isCurrent, status } from "../main";
import { ago, api, barChart, compactUsd, esc, lineChart, pct, signedUsd, typeLabel, usd } from "../lib";

export async function renderDashboard(app: HTMLElement, token: number) {
  const [ov, pf, eq, runs, alerts] = await Promise.all([
    api("/api/overview"),
    api("/api/portfolio"),
    api<{ t: string; equity: number }[]>("/api/equity"),
    api<any[]>("/api/agent/runs"),
    api<any[]>("/api/alerts"),
  ]);
  if (!isCurrent(token)) return;
  const lastRun = runs[0];

  app.innerHTML = `
    ${status?.mode === "mock" ? `<div class="banner">Mock mode: no CMC_API_KEY is set, so prices are synthetic or replayed from recorded fixtures. Add a key to .env for live data.</div>` : ""}
    <h1>Dashboard</h1>
    <p class="sub">Tokenized real-world assets on CoinMarketCap, and your AI-managed paper portfolio. Updated ${ago(ov.at)}.</p>

    <div class="tiles">
      <div class="card tile"><div class="label">Tokenized RWA market cap <span class="muted">(top ${ov.rwa.assets} assets)</span></div><div class="value">${usd(ov.rwa.tokenizedMcap, { compact: true })}</div><div class="delta muted">${usd(ov.rwa.vol24h, { compact: true })} 24h volume</div></div>
      <div class="card tile"><div class="label">RWA share of crypto market</div><div class="value">${ov.rwaSharePct?.toFixed(3) ?? "—"}%</div><div class="delta muted">of ${usd(ov.crypto.totalMcap, { compact: true })} total</div></div>
      <div class="card tile"><div class="label">Total crypto market cap, 24h</div><div class="value">${pct(ov.crypto.totalMcapChange24h)}</div><div class="delta muted">BTC dominance ${ov.crypto.btcDominance?.toFixed(1)}%</div></div>
      <div class="card tile"><div class="label">Tokens off-peg ≥1%</div><div class="value">${ov.depegCount}</div><div class="delta muted">of ${ov.rwa.tradableTokens} liquid tokens</div></div>
      <div class="card tile"><div class="label">Paper portfolio equity</div><div class="value">${usd(pf.equity, { dp: 0 })}</div><div class="delta">${signedUsd(pf.totalPnl)} (${pct(pf.totalPnlPct)})</div></div>
    </div>

    <div class="grid cols-2">
      <div class="card">
        <div class="spread"><h2>Portfolio equity</h2><a href="#/portfolio" class="small">Details →</a></div>
        <div class="chart-box">${eq.length > 1 ? `<canvas id="eq"></canvas>` : `<div class="empty">No history yet. Run the agent or place a trade.</div>`}</div>
      </div>
      <div class="card">
        <h2>Tokenized market cap by asset type</h2>
        <div class="chart-box"><canvas id="types"></canvas></div>
      </div>
    </div>

    <div class="grid cols-2" style="margin-top:16px">
      <div class="card">
        <div class="spread"><h2>Biggest moves vs peers</h2><a href="#/screener?signal=DISCOUNT" class="small">Screener →</a></div>
        ${table(ov.biggestDeviations, "premiumPct", "vs peers")}
      </div>
      <div class="card">
        <h2>Top 24h movers (liquid tokens)</h2>
        ${table(ov.topMovers, "change24h", "24h")}
      </div>
    </div>

    <div class="grid cols-2" style="margin-top:16px">
      <div class="card">
        <div class="spread"><h2>Latest agent run</h2><a href="#/agent" class="small">Agent →</a></div>
        ${lastRun ? `<p class="small muted">${esc(lastRun.engine === "claude" ? `Claude (${lastRun.model})` : "Rule engine")} · ${ago(lastRun.startedAt)} · ${esc(lastRun.status)}</p><p>${esc(lastRun.summary ?? "")}</p>` : `<div class="empty">The agent hasn't run yet. <a href="#/agent">Open the agent</a></div>`}
      </div>
      <div class="card">
        <div class="spread"><h2>Recent alerts</h2><a href="#/alerts" class="small">All →</a></div>
        ${alerts.length ? alerts.slice(0, 6).map((a) => `<div style="padding:6px 0;border-bottom:1px solid var(--border)"><div>${esc(a.title)}</div><div class="small muted">${esc(a.kind)} · ${ago(a.at)}</div></div>`).join("") : `<div class="empty">No alerts yet.</div>`}
      </div>
    </div>`;

  if (eq.length > 1) {
    lineChart(app.querySelector("#eq")!, eq.map((p) => new Date(p.t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })), eq.map((p) => p.equity), (v) => usd(v, { dp: 0 }));
  }
  barChart(app.querySelector("#types")!, ov.byType.map((t: any) => typeLabel(t.type)), ov.byType.map((t: any) => t.mcap), compactUsd);
}

function table(rows: any[], key: string, label: string) {
  if (!rows.length) return `<div class="empty">Nothing notable right now.</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>Token</th><th>Issuer</th><th class="num">Price</th><th class="num">${label}</th></tr></thead><tbody>
    ${rows.map((r) => `<tr class="clickable" onclick="location.hash='#/asset/${r.rwaId}'"><td><span class="sym">${esc(r.symbol)}</span> <span class="muted small">${esc(r.assetSymbol)}</span></td><td class="small">${esc(r.issuerName)}</td><td class="num">${usd(r.price)}</td><td class="num">${pct(r[key])}</td></tr>`).join("")}
  </tbody></table></div>`;
}
