import "./style.css";
import { api, destroyCharts, esc } from "./lib";
import { renderDashboard } from "./pages/dashboard";
import { renderScreener } from "./pages/screener";
import { renderAsset } from "./pages/asset";
import { renderAgent } from "./pages/agent";
import { renderPortfolio } from "./pages/portfolio";
import { renderIssuers } from "./pages/issuers";
import { renderAlerts, renderEvidence } from "./pages/misc";

export interface Status {
  mode: "live" | "mock";
  engine: "claude" | "rules";
  anthropicConfigured: boolean;
  model: string;
  adminRequired: boolean;
  agentRunning: boolean;
  scheduler: { lastMtmAt: string | null; lastAgentAt: string | null; nextAgentAt: string | null; lastError: string | null };
  cmc: { budget: { used: number; limit: number; remaining: number }; credits: number; live: number; cache: number; mock: number };
}
export let status: Status | null = null;

type Cleanup = (() => void) | void;
let cleanup: Cleanup;
let navToken = 0;

/** Pages call this to know whether they are still the current view after an await. */
export const isCurrent = (token: number) => token === navToken;

async function refreshStatus() {
  try {
    status = await api<Status>("/api/status");
    const b = status.cmc.budget;
    document.getElementById("status-pill")!.innerHTML = `
      <div><span class="dot ${status.mode}"></span> CMC ${status.mode === "live" ? "live data" : "mock data"}</div>
      <div>Agent: ${status.engine === "claude" ? "Claude" : "rule engine"}${status.agentRunning ? " · running…" : ""}</div>
      <div>Credits today: ${b.used}/${b.limit}</div>
      <div>Paper trading only</div>`;
  } catch {
    document.getElementById("status-pill")!.innerHTML = `<div class="down">API offline</div>`;
  }
}

async function route() {
  if (typeof cleanup === "function") cleanup();
  cleanup = undefined;
  destroyCharts();
  const token = ++navToken;
  const app = document.getElementById("app")!;
  const [path, query] = location.hash.replace(/^#\/?/, "").split("?");
  const parts = path.split("/").filter(Boolean);
  document.querySelectorAll<HTMLAnchorElement>(".nav nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === (parts[0] ?? "")));
  app.innerHTML = `<div class="spinner">Loading…</div>`;
  window.scrollTo(0, 0);
  const params = new URLSearchParams(query ?? "");
  try {
    switch (parts[0]) {
      case undefined: cleanup = await renderDashboard(app, token); break;
      case "screener": cleanup = await renderScreener(app, token, params); break;
      case "asset": cleanup = await renderAsset(app, token, Number(parts[1])); break;
      case "agent": cleanup = await renderAgent(app, token, parts[1]); break;
      case "portfolio": cleanup = await renderPortfolio(app, token); break;
      case "issuers": cleanup = await renderIssuers(app, token); break;
      case "alerts": cleanup = await renderAlerts(app, token); break;
      case "evidence": cleanup = await renderEvidence(app, token); break;
      default: app.innerHTML = `<div class="empty">Page not found. <a href="#/">Go to dashboard</a></div>`;
    }
  } catch (err) {
    if (isCurrent(token)) app.innerHTML = `<div class="card"><h2>Couldn't load this page</h2><p class="muted">${esc((err as Error).message)}</p><button onclick="location.reload()">Retry</button></div>`;
  }
}

window.addEventListener("hashchange", route);
await refreshStatus();
setInterval(refreshStatus, 15_000);
route();
