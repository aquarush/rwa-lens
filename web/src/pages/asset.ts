import { isCurrent } from "../main";
import { api, chips, compactUsd, esc, lineChart, pct, typeLabel, usd } from "../lib";
import { openTrade } from "../trade";

export async function renderAsset(app: HTMLElement, token: number, rwaId: number) {
  let interval = "daily";
  const draw = async () => {
    const d = await api(`/api/assets/${rwaId}?interval=${interval}&count=${interval === "hourly" ? 168 : 90}`);
    if (!isCurrent(token)) return;
    const first = d.tokens[0];
    const info = d.info ?? {};
    const name = info.name ?? first?.assetName ?? `Asset #${rwaId}`;
    const h = d.history as { t: string; price: number; mcap: number; vol: number }[];
    const desc = String(info.about?.description ?? "").replace(/#+\s*/g, "").replace(/\*\*/g, "").trim();
    const ret = h.length > 1 ? (h[h.length - 1].price / h[0].price - 1) * 100 : null;

    app.innerHTML = `
      <p class="small"><a href="#/screener">← Screener</a></p>
      <div class="spread"><div><h1>${esc(name)} <span class="muted">${esc(info.symbol ?? first?.assetSymbol ?? "")}</span></h1>
        <p class="sub">${typeLabel(info.asset_type ?? first?.assetType ?? "")}${info.primary_exchange ? ` · ${esc(info.primary_exchange)}` : ""}${info.industry ? ` · ${esc(info.industry)}` : ""} · ${d.tokens.length} tokens tracking it</p></div>
        <div class="row"><button class="${interval === "daily" ? "primary" : ""}" data-iv="daily">90 days</button><button class="${interval === "hourly" ? "primary" : ""}" data-iv="hourly">7 days hourly</button></div>
      </div>
      ${desc ? `<p class="muted" style="max-width:900px">${esc(desc.slice(0, 400))}${desc.length > 400 ? "…" : ""}</p>` : ""}
      <div class="grid cols-2">
        <div class="card"><h2>Average tokenized price <span class="muted small">${ret != null ? `period ${pct(ret)}` : ""}</span></h2><div class="chart-box">${h.length ? `<canvas id="px"></canvas>` : `<div class="empty">No history available.</div>`}</div></div>
        <div class="card"><h2>Tokenized 24h volume</h2><div class="chart-box">${h.length ? `<canvas id="vol"></canvas>` : `<div class="empty">No history available.</div>`}</div></div>
      </div>
      <div class="card" style="margin-top:16px"><h2>Tokens tracking ${esc(name)}</h2>
        <div class="table-wrap"><table><thead><tr><th>Token</th><th>Issuer</th><th class="num">Price</th><th class="num">vs peers</th><th class="num">24h</th><th class="num">Mkt cap</th><th class="num">24h vol</th><th>Signals</th><th></th></tr></thead><tbody>
        ${d.tokens.sort((a: any, b: any) => b.vol24h - a.vol24h).map((r: any, i: number) => `<tr><td><span class="sym">${esc(r.symbol)}</span><div class="small muted">${esc(r.name)}</div></td><td class="small">${esc(r.issuerName)}</td><td class="num">${usd(r.price)}</td><td class="num">${r.premiumPct == null ? `<span class="muted">n/a</span>` : pct(r.premiumPct)}</td><td class="num">${pct(r.change24h)}</td><td class="num">${usd(r.mcap, { compact: true })}</td><td class="num">${usd(r.vol24h, { compact: true })}</td><td>${chips(r.signals)}</td><td><button class="sm" data-trade="${i}">Trade</button></td></tr>`).join("") || `<tr><td colspan="9" class="empty">No tokens in the current universe.</td></tr>`}
        </tbody></table></div>
      </div>
      <div class="card" style="margin-top:16px"><h2>Market pairs</h2>
        ${d.pairs.length ? `<div class="table-wrap"><table><thead><tr><th>Exchange</th><th>Pair</th><th>Type</th><th class="num">Price</th><th class="num">24h volume</th></tr></thead><tbody>
          ${d.pairs.slice(0, 20).map((p: any) => `<tr><td>${esc(p.exchange)}</td><td class="sym">${esc(p.pair)}</td><td class="small muted">${esc(p.category)}</td><td class="num">${usd(p.price)}</td><td class="num">${usd(p.vol24h, { compact: true })}</td></tr>`).join("")}
        </tbody></table></div>` : `<div class="empty">${d.pairsError ? esc(d.pairsError) : "No market pairs returned."}</div>`}
      </div>`;

    if (h.length) {
      const labels = h.map((p) => new Date(p.t).toLocaleDateString([], interval === "hourly" ? { weekday: "short", hour: "2-digit" } : { month: "short", day: "numeric" }));
      lineChart(app.querySelector("#px")!, labels, h.map((p) => p.price), (v) => usd(v));
      lineChart(app.querySelector("#vol")!, labels, h.map((p) => p.vol), compactUsd, { fill: true });
    }
    app.querySelectorAll<HTMLElement>("button[data-iv]").forEach((b) => b.addEventListener("click", () => { interval = b.dataset.iv!; draw(); }));
    const sorted = d.tokens;
    app.querySelectorAll<HTMLElement>("button[data-trade]").forEach((b) => b.addEventListener("click", () => openTrade(sorted[Number(b.dataset.trade)])));
  };
  await draw();
}
