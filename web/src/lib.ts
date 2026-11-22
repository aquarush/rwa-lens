import { Chart, registerables, type ChartConfiguration } from "chart.js";
Chart.register(...registerables);

// ---------- API ----------
const tokenKey = "rwa-lens-admin-token";
export const adminToken = {
  get: () => { try { return localStorage.getItem(tokenKey) ?? ""; } catch { return ""; } },
  set: (v: string) => { try { localStorage.setItem(tokenKey, v); } catch {} },
};

export async function api<T = any>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const headers: Record<string, string> = {};
  if (init?.json !== undefined) headers["content-type"] = "application/json";
  const tok = adminToken.get();
  if (tok) headers["x-admin-token"] = tok;
  const res = await fetch(path, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string>) }, body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

// ---------- formatting ----------
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export function usd(n: number | null | undefined, opts: { compact?: boolean; dp?: number } = {}) {
  if (n == null || !isFinite(n)) return "—";
  if (opts.compact) return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }).format(n);
  const dp = opts.dp ?? (Math.abs(n) < 1 ? 4 : Math.abs(n) < 100 ? 3 : 2);
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: Math.min(2, dp), maximumFractionDigits: dp }).format(n);
}
export const num = (n: number | null | undefined, dp = 2) => (n == null || !isFinite(n) ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: dp }));
/** Signed percent with direction class; the sign is always shown so colour is never the only cue. */
export function pct(n: number | null | undefined, dp = 2) {
  if (n == null || !isFinite(n)) return `<span class="muted">—</span>`;
  const cls = n > 0 ? "up" : n < 0 ? "down" : "";
  return `<span class="${cls}">${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(dp)}%</span>`;
}
export function signedUsd(n: number) {
  const cls = n > 0 ? "up" : n < 0 ? "down" : "";
  return `<span class="${cls}">${n > 0 ? "+" : n < 0 ? "−" : ""}${usd(Math.abs(n))}</span>`;
}
export const ago = (iso?: string | null) => {
  if (!iso) return "—";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return `${Math.max(0, Math.round(s))}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
};
export const typeLabel = (t: string) => ({ stock: "Stock", etf: "ETF", commodity: "Commodity", currency: "Currency", government_security: "Treasury", real_estate: "Real estate" } as Record<string, string>)[t] ?? t;
export const chips = (xs: string[]) => xs.map((x) => `<span class="chip sig-${esc(x)}">${esc(x.replace("_", " ").toLowerCase())}</span>`).join("");
export const scoreCell = (s: number) => `<span class="score"><span class="bar"><i style="width:${s}%"></i></span>${s}</span>`;

// ---------- feedback ----------
export function toast(msg: string, err = false) {
  const el = document.createElement("div");
  el.className = `toast${err ? " err" : ""}`;
  el.textContent = msg;
  document.getElementById("toast-root")!.append(el);
  setTimeout(() => el.remove(), err ? 6000 : 3500);
}

export function modal(html: string, onMount: (root: HTMLElement, close: () => void) => void) {
  const root = document.getElementById("modal-root")!;
  root.innerHTML = `<div class="modal-backdrop"><div class="modal">${html}</div></div>`;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
    if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") root.querySelector<HTMLButtonElement>(".modal button.primary")?.click();
  };
  const close = () => {
    root.innerHTML = "";
    document.removeEventListener("keydown", onKey);
  };
  document.addEventListener("keydown", onKey);
  root.querySelector(".modal-backdrop")!.addEventListener("click", (e) => { if (e.target === e.currentTarget) close(); });
  const box = root.querySelector<HTMLElement>(".modal")!;
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  onMount(box, close);
  box.querySelector<HTMLElement>("input, select, button.primary")?.focus();
}

// ---------- charts ----------
const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const live: Chart[] = [];
export function destroyCharts() { while (live.length) live.pop()!.destroy(); }

function baseOptions(): any {
  const muted = css("--text-muted"), grid = css("--grid"), ink = css("--text-primary"), surface = css("--surface-1");
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: { backgroundColor: surface, titleColor: ink, bodyColor: ink, borderColor: grid, borderWidth: 1, padding: 10, displayColors: false },
    },
    scales: {
      x: { grid: { display: false }, ticks: { color: muted, maxRotation: 0, autoSkipPadding: 18 }, border: { color: grid } },
      y: { grid: { color: grid }, ticks: { color: muted }, border: { display: false } },
    },
  };
}

/** Single-series line with crosshair tooltip. */
export function lineChart(canvas: HTMLCanvasElement, labels: string[], data: number[], fmt: (v: number) => string, opts: { fill?: boolean } = {}) {
  const color = css("--series-1");
  const o = baseOptions();
  o.plugins.tooltip.callbacks = { label: (c: any) => fmt(c.parsed.y) };
  o.scales.y.ticks.callback = (v: number) => fmt(v);
  const cfg: ChartConfiguration<"line"> = {
    type: "line",
    data: { labels, datasets: [{ data, borderColor: color, borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, pointHoverBorderWidth: 2, pointHoverBorderColor: css("--surface-1"), pointHoverBackgroundColor: color, tension: 0.25, fill: opts.fill ? { target: "origin" } : false, backgroundColor: color + "1f" }] },
    options: o,
  };
  const c = new Chart(canvas, cfg);
  live.push(c);
  return c;
}

/** Single-series horizontal bar (magnitude). */
export function barChart(canvas: HTMLCanvasElement, labels: string[], data: number[], fmt: (v: number) => string) {
  const color = css("--series-1");
  const o = baseOptions();
  o.indexAxis = "y";
  o.interaction = { mode: "nearest", axis: "y", intersect: false };
  o.plugins.tooltip.callbacks = { label: (c: any) => fmt(c.parsed.x) };
  o.scales.x = { grid: { color: css("--grid") }, ticks: { color: css("--text-muted"), callback: (v: number) => fmt(v) }, border: { display: false } };
  o.scales.y = { grid: { display: false }, ticks: { color: css("--text-secondary") }, border: { color: css("--grid") } };
  const c = new Chart(canvas, {
    type: "bar",
    data: { labels, datasets: [{ data, backgroundColor: color, borderRadius: 4, borderSkipped: "start", barPercentage: 0.7, categoryPercentage: 0.9 }] },
    options: o,
  });
  live.push(c);
  return c;
}

export const compactUsd = (v: number) => usd(v, { compact: true });
