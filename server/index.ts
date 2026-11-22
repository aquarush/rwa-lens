// Node entry point. bootstrap must be the first import (loads .env, file storage).
import { ROOT } from "./node/bootstrap.ts";
import fs from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { closeStaleRuns } from "./agent/journal.ts";
import { createApp } from "./app.ts";
import { config, mockMode } from "./config.ts";
import { startScheduler } from "./scheduler.ts";

const app = createApp();

const dist = path.join(ROOT, "web", "dist");
const hasUi = fs.existsSync(dist);
if (hasUi) {
  const root = path.relative(process.cwd(), dist) || ".";
  app.use("/*", serveStatic({ root }));
  // single-page app: unknown non-API paths get index.html
  app.get("*", serveStatic({ root, path: "index.html" }));
} else {
  // API-only (e.g. `npm run dev`, where Vite serves the UI on :5173)
  app.get("/", (c) =>
    c.html(`<p style="font-family:sans-serif">RWA Lens API is running. Build the UI with <code>npm run build</code> and restart, or use <code>npm run dev</code> and open <a href="http://localhost:5173">http://localhost:5173</a>.</p>`),
  );
}

closeStaleRuns();
startScheduler();

const host = process.env.HOST ?? "0.0.0.0";
serve({ fetch: app.fetch, port: config.port, hostname: host }, () => {
  console.log(`RWA Lens on http://localhost:${config.port}${hasUi ? "" : "  (API only - UI not built; run npm run build, or npm run dev for :5173)"}`);
  console.log(`  CMC data: ${mockMode() ? "MOCK (no CMC_API_KEY - synthetic/recorded fixtures)" : "LIVE"}`);
  console.log(`  Agent: rule-based strategy on CMC data (no external AI service)`);
  console.log(`  Paper trading only: no real orders are ever sent.`);
});
