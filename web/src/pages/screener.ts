import { isCurrent } from "../main";
import { ago, api, chips, esc, pct, scoreCell, typeLabel, usd } from "../lib";
import { openTrade } from "../trade";

const COLS: { key: string; label: string; num?: boolean; sm?: boolean }[] = [
  { key: "symbol", label: "Token" },
  { sm: true, key: "assetSymbol", label: "Asset" },
  { sm: true, key: "issuerName", label: "Issuer" },
  { key: "price", label: "Price", num: true },
  { key: "premiumPct", label: "vs peers", num: true },
  { key: "change24h", label: "24h", num: true },
  { sm: true, key: "change7d", label: "7d", num: true },
  { sm: true, key: "mcap", label: "Mkt cap", num: true },
  { sm: true, key: "vol24h", label: "24h vol", num: true },
  { key: "score", label: "Score", num: true },
];

export async function renderScreener(app: HTMLElement, token: number, params: URLSearchParams) {
  const state = {
    q: params.get("q") ?? "",
    assetType: params.get("assetType") ?? "",
    signal: params.get("signal") ?? "",
    minVol: params.get("minVol") ?? "",
    tradableOnly: params.get("tradableOnly") === "true",
    sort: params.get("sort") ?? "score",
    dir: params.get("dir") ?? "desc",
  };

  app.innerHTML = `
    <h1>Screener</h1>
    <p class="sub">Every token that tracks a top tokenized asset. <b>vs peers</b> compares a token with the volume-weighted median price of its sibling tokens (same asset, same unit, excluding itself). Score blends liquidity, momentum, value vs peers and size.</p>
    <div class="filters">
      <label class="field">Search<input id="q" placeholder="NVDA, gold, Ondo…" value="${esc(state.q)}" /></label>
      <label class="field">Asset type<select id="assetType"><option value="">All</option>${["stock", "etf", "commodity", "currency", "government_security", "real_estate"].map((t) => `<option value="${t}" ${state.assetType === t ? "selected" : ""}>${typeLabel(t)}</option>`).join("")}</select></label>
      <label class="field">Signal<select id="signal"><option value="">Any</option>${["DISCOUNT", "PREMIUM", "MOMENTUM_UP", "MOMENTUM_DOWN", "REBOUND", "LEVERAGED", "UNIT_MISMATCH", "ILLIQUID"].map((s) => `<option value="${s}" ${state.signal === s ? "selected" : ""}>${s.replace("_", " ").toLowerCase()}</option>`).join("")}</select></label>
      <label class="field">Min 24h volume<select id="minVol">${[["", "Any"], ["100000", "$100k"], ["1000000", "$1M"], ["10000000", "$10M"]].map(([v, l]) => `<option value="${v}" ${state.minVol === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label class="check" style="padding-bottom:8px"><input type="checkbox" id="tradableOnly" ${state.tradableOnly ? "checked" : ""}/> Liquid only</label>
      <span class="muted small" id="meta" style="padding-bottom:9px;margin-left:auto"></span>
    </div>
    <div class="card"><div class="table-wrap" id="tbl"><div class="spinner">Loading…</div></div></div>`;

  async function load() {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(state)) if (v !== "" && v !== false) qs.set(k, String(v));
    history.replaceState(null, "", `#/screener?${qs}`);
    const data = await api(`/api/screener?${qs}`);
    if (!isCurrent(token)) return;
    app.querySelector("#meta")!.textContent = `${data.count} of ${data.total} tokens · data ${ago(data.at)}`;
    const tbl = app.querySelector("#tbl")!;
    if (!data.rows.length) {
      tbl.innerHTML = `<div class="empty">No tokens match these filters.</div>`;
      return;
    }
    tbl.innerHTML = `<table><thead><tr>${COLS.map((c) => `<th class="sortable ${c.num ? "num" : ""} ${c.sm ? "hide-sm" : ""}" data-k="${c.key}">${c.label}${state.sort === c.key ? (state.dir === "asc" ? " ↑" : " ↓") : ""}</th>`).join("")}<th class="hide-sm">Signals</th><th></th></tr></thead><tbody>
      ${data.rows.map((r: any, i: number) => `<tr class="clickable" data-rwa="${r.rwaId}">
        <td><span class="sym">${esc(r.symbol)}</span><div class="small muted">${esc(r.name)}</div></td>
        <td class="hide-sm">${esc(r.assetSymbol)}<div class="small muted">${typeLabel(r.assetType)}</div></td>
        <td class="small hide-sm">${esc(r.issuerName)}</td>
        <td class="num">${usd(r.price)}</td>
        <td class="num">${r.premiumPct == null ? `<span class="muted" title="${r.signals.includes("UNIT_MISMATCH") ? "different unit from its siblings" : "no comparable sibling"}">n/a</span>` : pct(r.premiumPct)}</td>
        <td class="num">${pct(r.change24h)}</td>
        <td class="num hide-sm">${pct(r.change7d)}</td>
        <td class="num hide-sm">${usd(r.mcap, { compact: true })}</td>
        <td class="num hide-sm">${usd(r.vol24h, { compact: true })}</td>
        <td class="num">${scoreCell(r.score)}</td>
        <td class="hide-sm">${chips(r.signals)}</td>
        <td><button class="sm" data-trade="${i}">Trade</button></td>
      </tr>`).join("")}
    </tbody></table>`;
    tbl.querySelectorAll<HTMLElement>("th.sortable").forEach((th) => th.addEventListener("click", () => {
      const k = th.dataset.k!;
      state.dir = state.sort === k && state.dir === "desc" ? "asc" : "desc";
      state.sort = k;
      load();
    }));
    tbl.querySelectorAll<HTMLElement>("tr[data-rwa]").forEach((tr) => tr.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest("button[data-trade]") as HTMLElement | null;
      if (btn) openTrade(data.rows[Number(btn.dataset.trade)]);
      else location.hash = `#/asset/${tr.dataset.rwa}`;
    }));
  }

  let t: number | undefined;
  app.querySelector("#q")!.addEventListener("input", (e) => {
    clearTimeout(t);
    t = window.setTimeout(() => { state.q = (e.target as HTMLInputElement).value; load(); }, 250);
  });
  for (const id of ["assetType", "signal", "minVol"] as const) app.querySelector(`#${id}`)!.addEventListener("change", (e) => { state[id] = (e.target as HTMLSelectElement).value; load(); });
  app.querySelector("#tradableOnly")!.addEventListener("change", (e) => { state.tradableOnly = (e.target as HTMLInputElement).checked; load(); });
  await load();
}
