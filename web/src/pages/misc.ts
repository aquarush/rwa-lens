import { isCurrent, status } from "../main";
import { ago, api, esc } from "../lib";

export async function renderAlerts(app: HTMLElement, token: number) {
  const alerts = await api<any[]>("/api/alerts");
  if (!isCurrent(token)) return;
  app.innerHTML = `
    <h1>Alerts</h1>
    <p class="sub">De-pegs (a liquid token ≥1.5% away from its peers), risk exits (stop-loss / take-profit), agent runs and trades. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to receive them on Telegram too.</p>
    <div class="card">${alerts.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Kind</th><th>Alert</th></tr></thead><tbody>
      ${alerts.map((a) => `<tr><td class="small muted" title="${esc(a.at)}">${ago(a.at)}</td><td><span class="chip">${esc(a.kind)}</span></td><td>${esc(a.title)}${a.detail ? `<div class="small muted">${esc(a.detail)}</div>` : ""}</td></tr>`).join("")}
    </tbody></table></div>` : `<div class="empty">No alerts yet. Opening the screener scans for de-pegs.</div>`}</div>`;
}

export async function renderEvidence(app: HTMLElement, token: number) {
  const [ev, key] = await Promise.all([api("/api/evidence"), api("/api/key-info").catch(() => null)]);
  if (!isCurrent(token)) return;
  const b = status?.cmc.budget;
  const usage = key?.usage;
  app.innerHTML = `
    <h1>API evidence</h1>
    <p class="sub">Every live CoinMarketCap call is logged to <code>evidence/cmc-calls.jsonl</code> with the API key redacted. Responses are cached to save credits, and a daily credit budget stops runaway usage.</p>
    <div class="tiles">
      <div class="card tile"><div class="label">Data mode</div><div class="value">${status?.mode === "live" ? "Live" : "Mock"}</div></div>
      <div class="card tile"><div class="label">Credits used today (app budget)</div><div class="value">${b ? `${b.used} / ${b.limit}` : "—"}</div></div>
      ${usage ? `<div class="card tile"><div class="label">CMC account: credits this month</div><div class="value">${usage.current_month?.credits_used ?? "—"}</div><div class="delta muted">${usage.current_month?.credits_left ?? "—"} left</div></div>` : ""}
      <div class="card tile"><div class="label">This session</div><div class="value">${status?.cmc.live ?? 0} live</div><div class="delta muted">${status?.cmc.cache ?? 0} served from cache</div></div>
    </div>
    <div class="card"><h2>Recent calls (this session)</h2>
      ${ev.recent.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Source</th><th>Endpoint</th><th>Params</th><th class="num">HTTP</th><th class="num">Credits</th><th class="num">ms</th></tr></thead><tbody>
      ${ev.recent.map((c: any) => `<tr><td class="small muted">${ago(c.at)}</td><td><span class="chip">${esc(c.source)}</span></td><td class="nowrap"><code>${esc(c.endpoint)}</code>${c.error ? `<div class="small down">${esc(c.error)}</div>` : ""}</td><td class="small muted params" title="${esc(new URLSearchParams(c.params).toString())}">${esc(decodeURIComponent(new URLSearchParams(c.params).toString()))}</td><td class="num">${c.httpStatus}</td><td class="num">${c.credits}</td><td class="num">${c.elapsedMs}</td></tr>`).join("")}
      </tbody></table></div>` : `<div class="empty">No calls yet this session.</div>`}
    </div>
    <div class="card" style="margin-top:16px"><h2>Evidence log (latest live calls, key redacted)</h2>
      ${ev.calls.length ? ev.calls.slice(0, 15).map((c: any) => `<details style="margin-bottom:8px"><summary><code>${esc(c.endpoint)}</code> · HTTP ${c.httpStatus} · ${c.credits} credit(s) · ${esc(c.at)}</summary><pre class="code">${esc(`GET ${c.url}\nX-CMC_PRO_API_KEY: <redacted>\n\n${c.responsePreview}`)}</pre></details>`).join("") : `<div class="empty">No live calls recorded yet${status?.mode === "mock" ? " (mock mode)" : ""}.</div>`}
    </div>`;
}
