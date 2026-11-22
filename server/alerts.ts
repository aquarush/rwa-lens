/**
 * Alerts feed (in-app) with optional Telegram delivery. De-duplicates per key
 * so a token sitting off-peg doesn't spam every refresh.
 */
import { background, config } from "./config.ts";
import type { ScreenRow } from "./screener.ts";
import { jsonStore } from "./store.ts";

export interface Alert { id: string; at: string; kind: "depeg" | "trade" | "risk" | "agent"; title: string; detail?: string; key: string }

const store = jsonStore<{ alerts: Alert[]; lastByKey: Record<string, number> }>("alerts.json", () => ({ alerts: [], lastByKey: {} }));
const DEDUPE_MS = 6 * 3600_000;

async function telegram(text: string) {
  if (!config.telegramToken || !config.telegramChat) return;
  try {
    await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: config.telegramChat, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.warn("[alerts] telegram failed:", (err as Error).message);
  }
}

export function pushAlert(kind: Alert["kind"], key: string, title: string, detail?: string, dedupe = true) {
  const s = store.get();
  if (dedupe && Date.now() - (s.lastByKey[key] ?? 0) < DEDUPE_MS) return null;
  const a: Alert = { id: crypto.randomUUID(), at: new Date().toISOString(), kind, title, detail, key };
  store.update((st) => {
    st.alerts.push(a);
    st.lastByKey[key] = Date.now();
    if (st.alerts.length > 150) st.alerts = st.alerts.slice(-150);
  });
  background(telegram(`RWA Lens · ${title}${detail ? `\n${detail}` : ""}`));
  return a;
}

export function scanDepegs(rows: ScreenRow[]) {
  for (const r of rows) {
    if (!r.tradable || r.premiumPct == null || Math.abs(r.premiumPct) < config.depegAlertPct) continue;
    const dir = r.premiumPct > 0 ? "premium" : "discount";
    pushAlert(
      "depeg",
      `depeg:${r.cryptoId}:${dir}`,
      `${r.symbol} (${r.issuerName}) at ${r.premiumPct.toFixed(2)}% ${dir}`,
      `${r.assetName}: token $${r.price.toFixed(4)} vs peer reference $${r.refPrice?.toFixed(4)} (${r.peers} tokens); 24h vol $${Math.round(r.vol24h).toLocaleString()}`,
    );
  }
}

export const listAlerts = (limit = 100) => store.get().alerts.slice(-limit).reverse();
