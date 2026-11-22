import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { closeStaleRuns } from "./agent/journal.ts";
import { resolveEngine } from "./agent/run.ts";
import { config, mockMode, ROOT } from "./config.ts";
import { routes } from "./routes.ts";
import { startScheduler } from "./scheduler.ts";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "warn" } });

await app.register(routes);

const dist = path.join(ROOT, "web", "dist");
if (fs.existsSync(dist)) {
  await app.register(fastifyStatic, { root: dist });
  app.setNotFoundHandler((req, reply) => (req.url.startsWith("/api/") ? reply.code(404).send({ error: "not found" }) : reply.sendFile("index.html")));
}

closeStaleRuns();
startScheduler();

await app.listen({ port: config.port, host: process.env.HOST ?? "0.0.0.0" });
console.log(`RWA Lens API on http://localhost:${config.port}`);
console.log(`  CMC data: ${mockMode() ? "MOCK (no CMC_API_KEY - synthetic/recorded fixtures)" : "LIVE"}`);
console.log(`  Agent engine: ${resolveEngine()}${resolveEngine() === "rules" ? " (set ANTHROPIC_API_KEY to use Claude)" : ` (${config.anthropicModel})`}`);
console.log(`  Paper trading only: no real orders are ever sent.`);
