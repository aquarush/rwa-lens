import { isCurrent } from "../main";
import { api, barChart, compactUsd, esc, typeLabel, usd } from "../lib";

export async function renderIssuers(app: HTMLElement, token: number) {
  const d = await api("/api/issuers");
  if (!isCurrent(token)) return;
  const rows = d.scorecard.filter((r: any) => r.mcap > 0);
  const top = rows.slice(0, 12);
  app.innerHTML = `
    <h1>Issuer scorecard</h1>
    <p class="sub">Who tokenizes what, built from the tokens in the screener universe plus CMC's issuer directory (${d.directoryCount} issuers listed). <b>Peg tightness</b> is the average absolute deviation of an issuer's tokens from their peers: lower means tighter tracking.</p>
    <div class="card"><h2>Tokenized market cap by issuer (top 12)</h2><div class="chart-box tall"><canvas id="mc"></canvas></div></div>
    <div class="card" style="margin-top:16px"><div class="table-wrap"><table><thead><tr><th>Issuer</th><th class="num">Tokens</th><th class="num">Assets</th><th>Types</th><th class="num">Mkt cap</th><th class="num">24h vol</th><th class="num">Turnover</th><th class="num">Peg tightness</th></tr></thead><tbody>
      ${rows.map((r: any) => `<tr><td><b>${esc(r.issuer)}</b>${r.website ? `<div class="small"><a href="${esc(r.website)}" target="_blank" rel="noopener">${esc(r.website.replace(/^https?:\/\//, ""))}</a></div>` : ""}</td><td class="num">${r.tokens}${r.totalTokensListed ? `<div class="small muted">${r.totalTokensListed} listed</div>` : ""}</td><td class="num">${r.assets}</td><td class="small">${r.assetTypes.map(typeLabel).join(", ")}</td><td class="num">${usd(r.mcap, { compact: true })}</td><td class="num">${usd(r.vol24h, { compact: true })}</td><td class="num">${r.turnover == null ? "—" : `${(r.turnover * 100).toFixed(1)}%`}</td><td class="num">${r.avgAbsPremiumPct == null ? "—" : `±${r.avgAbsPremiumPct.toFixed(2)}%`}</td></tr>`).join("")}
    </tbody></table></div></div>`;
  barChart(app.querySelector("#mc")!, top.map((r: any) => r.issuer), top.map((r: any) => r.mcap), compactUsd);
}
