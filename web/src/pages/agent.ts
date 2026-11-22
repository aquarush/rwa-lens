import { isCurrent, status } from "../main";
import { adminToken, ago, api, esc, pct, toast, typeLabel, usd } from "../lib";

const TYPES = ["stock", "etf", "commodity", "currency", "government_security", "real_estate"];

export async function renderAgent(app: HTMLElement, token: number, runId?: string) {
  let selected = runId;
  const [settings, runs, pf] = await Promise.all([api("/api/settings"), api<any[]>("/api/agent/runs"), api("/api/portfolio")]);
  if (!isCurrent(token)) return;
  selected ??= runs[0]?.id;

  const engineNote = status?.engine === "claude"
    ? `Claude <b>${esc(status.model)}</b> researches with tools (screen, token detail, portfolio) and places orders. Every order passes the risk limits below.`
    : `Running the <b>rule engine</b>${status?.anthropicConfigured ? "" : " because no ANTHROPIC_API_KEY is set"}. Add a key to .env to let Claude make the decisions; the risk limits apply either way.`;

  app.innerHTML = `
    <div class="spread"><div><h1>AI Agent</h1><p class="sub">${engineNote}</p></div>
      <div class="row"><button class="primary" id="run" ${status?.agentRunning ? "disabled" : ""}>${status?.agentRunning ? "Running…" : "Run agent now"}</button></div></div>
    ${status?.adminRequired ? `<div class="banner">This deployment requires an admin token for actions. <input id="tok" placeholder="admin token" value="${esc(adminToken.get())}" style="margin-left:8px"/> <button class="sm" id="savetok">Save</button></div>` : ""}

    ${pf.pending.length ? `<div class="card" style="margin-bottom:16px"><h2>Waiting for your approval (${pf.pending.length})</h2>
      <div class="table-wrap"><table><thead><tr><th>Side</th><th>Token</th><th class="num">Amount</th><th>Agent's reason</th><th class="hide-sm">Proposed</th><th></th></tr></thead><tbody>
      ${pf.pending.map((o: any) => `<tr><td><b>${o.side.toUpperCase()}</b></td><td class="sym">${esc(o.symbol)}</td><td class="num">${o.side === "buy" ? usd(o.requestedUsd, { dp: 0 }) : o.requestedQty ? "partial" : "close"}</td><td class="small">${esc(o.reason)}</td><td class="small muted hide-sm">${ago(o.at)}</td>
        <td class="row" style="flex-wrap:nowrap"><button class="sm primary" data-approve="${o.id}">Approve</button><button class="sm" data-cancel="${o.id}">Reject</button></td></tr>`).join("")}
      </tbody></table></div>
      <div class="row" style="margin-top:10px"><button class="sm" id="approve-all">Approve all</button></div></div>` : ""}

    <div class="grid runs-layout">
      <div class="card"><h2>Runs</h2><div id="runs">${runs.length ? runs.map((r) => `
        <div class="run-item ${r.id === selected ? "active" : ""}" data-run="${r.id}">
          <div class="spread"><b>${r.engine === "claude" ? "Claude" : "Rules"}</b><span class="small muted">${ago(r.startedAt)}</span></div>
          <div class="small ${r.status === "error" ? "down" : "muted"}">${esc(r.status)} · ${r.trigger} · ${r.orderIds.length} order${r.orderIds.length === 1 ? "" : "s"}</div>
        </div>`).join("") : `<div class="empty">No runs yet.</div>`}</div></div>
      <div class="card" id="detail"><div class="empty">Select a run.</div></div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="spread"><h2>Agent & risk settings</h2><button class="primary" id="save">Save settings</button></div>
      <div class="form-grid">
        <label class="check"><input type="checkbox" id="agentEnabled" ${settings.agentEnabled ? "checked" : ""}/> Run on a schedule</label>
        <label class="field">Every (minutes)<input type="number" id="intervalMin" min="5" value="${settings.intervalMin}"/></label>
        <label class="check"><input type="checkbox" id="autopilot" ${settings.autopilot ? "checked" : ""}/> Autopilot (fill without approval)</label>
        <label class="field">Engine<select id="engine">${[["auto", "Auto (Claude if key set)"], ["claude", "Claude"], ["rules", "Rule engine"]].map(([v, l]) => `<option value="${v}" ${settings.engine === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="check"><input type="checkbox" id="killSwitch" ${settings.killSwitch ? "checked" : ""}/> <span class="down">Kill switch (block all new orders)</span></label>
        <label class="check"><input type="checkbox" id="avoidLeveraged" ${settings.avoidLeveraged ? "checked" : ""}/> Avoid leveraged/inverse ETFs</label>
      </div>
      <h3 style="margin-top:16px">Risk limits (enforced in code on every order)</h3>
      <div class="form-grid">
        ${numField("maxPositionPct", "Max position, % of equity", settings)}
        ${numField("maxGrossExposurePct", "Max gross exposure, %", settings)}
        ${numField("minCashPct", "Min cash, % of equity", settings)}
        ${numField("minTradeUsd", "Min trade, USD", settings)}
        ${numField("maxOrdersPerRun", "Max orders per run", settings)}
        ${numField("minVol24h", "Min token 24h volume, USD", settings)}
        ${numField("maxBuyPremiumPct", "Don't buy above premium, %", settings)}
        ${numField("stopLossPct", "Stop-loss, % (0 = off)", settings)}
        ${numField("takeProfitPct", "Take-profit, % (0 = off)", settings)}
      </div>
      <h3 style="margin-top:16px">Allowed asset types</h3>
      <div class="row">${TYPES.map((t) => `<label class="check"><input type="checkbox" data-type="${t}" ${settings.allowedTypes.includes(t) ? "checked" : ""}/> ${typeLabel(t)}</label>`).join("")}</div>
      <label class="field" style="margin-top:16px">Blocked symbols (comma-separated)<input id="blockedSymbols" value="${esc(settings.blockedSymbols.join(", "))}"/></label>
      <label class="field" style="margin-top:12px">Strategy notes for the agent<textarea id="strategyNotes" placeholder="e.g. Prefer gold and broad ETFs; avoid single stocks over the weekend; keep positions small.">${esc(settings.strategyNotes)}</textarea></label>
    </div>`;

  // ----- actions -----
  app.querySelector("#savetok")?.addEventListener("click", () => { adminToken.set((app.querySelector("#tok") as HTMLInputElement).value); toast("Token saved"); });
  app.querySelector("#run")!.addEventListener("click", async (e) => {
    const btn = e.target as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "Running…";
    try {
      const r = await api("/api/agent/run", { method: "POST" });
      selected = r.run?.id;
      toast("Agent run started");
      poll();
    } catch (err) {
      toast((err as Error).message, true);
      btn.disabled = false;
      btn.textContent = "Run agent now";
    }
  });
  const act = async (path: string, msg: string) => {
    try {
      const o = await api(path, { method: "POST" });
      toast(o.status === "rejected" ? `Rejected: ${o.rejectReason}` : msg, o.status === "rejected");
    } catch (err) { toast((err as Error).message, true); }
    renderAgent(app, token, selected);
  };
  app.querySelectorAll<HTMLElement>("[data-approve]").forEach((b) => b.addEventListener("click", () => act(`/api/orders/${b.dataset.approve}/approve`, "Order approved and filled")));
  app.querySelectorAll<HTMLElement>("[data-cancel]").forEach((b) => b.addEventListener("click", () => act(`/api/orders/${b.dataset.cancel}/cancel`, "Order rejected")));
  app.querySelector("#approve-all")?.addEventListener("click", async () => {
    for (const o of pf.pending) {
      try {
        const r = await api(`/api/orders/${o.id}/approve`, { method: "POST" });
        if (r.status === "rejected") toast(`${o.symbol} rejected: ${r.rejectReason}`, true);
      } catch (err) { toast((err as Error).message, true); }
    }
    renderAgent(app, token, selected);
  });
  app.querySelector("#save")!.addEventListener("click", async () => {
    const v = (id: string) => (app.querySelector(`#${id}`) as HTMLInputElement);
    const patch: Record<string, unknown> = {
      agentEnabled: v("agentEnabled").checked, autopilot: v("autopilot").checked, killSwitch: v("killSwitch").checked, avoidLeveraged: v("avoidLeveraged").checked,
      intervalMin: Number(v("intervalMin").value), engine: v("engine").value, strategyNotes: v("strategyNotes").value,
      blockedSymbols: v("blockedSymbols").value.split(",").map((s) => s.trim()).filter(Boolean),
      allowedTypes: [...app.querySelectorAll<HTMLInputElement>("[data-type]")].filter((c) => c.checked).map((c) => c.dataset.type),
    };
    for (const k of ["maxPositionPct", "maxGrossExposurePct", "minCashPct", "minTradeUsd", "maxOrdersPerRun", "minVol24h", "maxBuyPremiumPct", "stopLossPct", "takeProfitPct"]) patch[k] = Number(v(k).value);
    try {
      await api("/api/settings", { method: "PUT", json: patch });
      toast("Settings saved");
    } catch (err) { toast((err as Error).message, true); }
  });
  app.querySelectorAll<HTMLElement>("[data-run]").forEach((el) => el.addEventListener("click", () => {
    selected = el.dataset.run;
    app.querySelectorAll(".run-item").forEach((x) => x.classList.toggle("active", x === el));
    showRun();
  }));

  async function showRun() {
    const box = app.querySelector("#detail")!;
    if (!selected) return;
    const r = await api(`/api/agent/runs/${selected}`);
    if (!isCurrent(token)) return;
    const delta = r.equityAfter != null && r.equityBefore != null ? ((r.equityAfter / r.equityBefore - 1) * 100) : null;
    box.innerHTML = `
      <div class="spread"><h2>${r.engine === "claude" ? `Claude · ${esc(r.model)}` : "Rule engine"}</h2><span class="small muted">${new Date(r.startedAt).toLocaleString()}${r.finishedAt ? ` · ${Math.round((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000)}s` : ""}</span></div>
      <p>${esc(r.summary ?? (r.status === "running" ? "Running…" : ""))}</p>
      <p class="small muted">Status ${esc(r.status)} · ${r.orderIds.length} order(s) · equity ${usd(r.equityBefore, { dp: 0 })} → ${usd(r.equityAfter, { dp: 0 })} ${delta != null ? `(${pct(delta, 3)})` : ""}${r.usage ? ` · tokens in ${r.usage.input.toLocaleString()} / out ${r.usage.output.toLocaleString()} / cache read ${r.usage.cacheRead.toLocaleString()}` : ""}</p>
      <h3>Journal</h3>
      <div class="journal">${r.steps.map((s: any) => `<div class="step ${s.type}"><div class="t">${new Date(s.t).toLocaleTimeString()} · ${s.type.replace("_", " ")}</div><div>${esc(s.title)}</div>${detail(s)}</div>`).join("")}</div>`;
  }

  let timer: number | undefined;
  async function poll() {
    clearTimeout(timer);
    await showRun();
    const r = await api(`/api/agent/runs/${selected}`).catch(() => null);
    if (!isCurrent(token)) return;
    if (r?.status === "running") timer = window.setTimeout(poll, 1500);
    else renderAgent(app, token, selected);
  }
  if (selected) {
    const sel = runs.find((r) => r.id === selected);
    if (sel?.status === "running") poll(); else showRun();
  }
  return () => clearTimeout(timer);
}

function numField(id: string, label: string, s: Record<string, number>) {
  return `<label class="field">${label}<input type="number" id="${id}" value="${s[id]}" step="any"/></label>`;
}

function detail(s: any) {
  if (s.detail == null) return "";
  if (typeof s.detail === "string") return s.type === "text" || s.type === "thinking" ? `<pre>${esc(s.detail)}</pre>` : `<details><summary>details</summary><pre>${esc(s.detail)}</pre></details>`;
  return `<details><summary>details</summary><pre>${esc(JSON.stringify(s.detail, null, 1))}</pre></details>`;
}
