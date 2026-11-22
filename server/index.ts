import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { closeStaleRuns } from "./agent/journal.ts";
import { config, mockMode, ROOT } from "./config.ts";
import { routes } from "./routes.ts";
import { startScheduler } from "./scheduler.ts";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "warn" } });

await app.register(routes);

const dist = path.join(ROOT, "web", "dist");
if (fs.existsSync(dist)) {
  await app.register(fastifyStatic, { root: dist });
  app.setNotFoundHandler((req, reply) => (req.url.startsWith("/api/") ? reply.code(404).send({ error: "not found" }) : reply.sendFile("index.html")));
} else {
  // API-only (e.g. `npm run dev`, where Vite serves the UI on :5173)
  app.get("/", async (_req, reply) =>
    reply.type("text/html").send(`<p style="font-family:sans-serif">RWA Lens API is running. Build the UI with <code>npm run build</code> and restart, or use <code>npm run dev</code> and open <a href="http://localhost:5173">http://localhost:5173</a>.</p>`));
}

closeStaleRuns();
startScheduler();

await app.listen({ port: config.port, host: process.env.HOST ?? "0.0.0.0" });
console.log(`RWA Lens on http://localhost:${config.port}${fs.existsSync(dist) ? "" : "  (API only - UI not built; run npm run build, or npm run dev for :5173)"}`);
console.log(`  CMC data: ${mockMode() ? "MOCK (no CMC_API_KEY - synthetic/recorded fixtures)" : "LIVE"}`);
console.log(`  Agent: rule-based strategy on CMC data (no external AI service)`);
console.log(`  Paper trading only: no real orders are ever sent.`);
