import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { getRun, isRunning, listRuns } from "./agent/journal.ts";
import { resolveEngine, runAgent } from "./agent/run.ts";
import { listAlerts, pushAlert, scanDepegs } from "./alerts.ts";
import { CmcError, cmcStats, readEvidence } from "./cmc.ts";
import { config, hasAnthropicCreds, mockMode } from "./config.ts";
import {
  approvePending, cancelPending, equityHistory, orderHistory, placeOrder, portfolioSummary, resetPortfolio,
} from "./portfolio.ts";
import { assetHistory, assetInfo, issuers, keyInfo, marketPairs, type AssetType } from "./rwa.ts";
import { schedulerState, quickMarkToMarket } from "./scheduler.ts";
import { filterRows, issuerScorecard, lastSnapshotRows, marketOverview, snapshot, type Signal } from "./screener.ts";
import { getSettings, SettingsSchema, updateSettings } from "./settings.ts";

const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";

/** Mutating routes require x-admin-token when ADMIN_TOKEN is set (public deploys). */
async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  if (!ADMIN_TOKEN) return;
  if (req.headers["x-admin-token"] !== ADMIN_TOKEN) {
    reply.code(401).send({ error: "admin token required for this action" });
  }
}

const num = (v: unknown) => (v === undefined || v === "" ? undefined : Number(v));

export async function routes(app: FastifyInstance) {
  app.setErrorHandler((err: Error, _req, reply) => {
    const status = err instanceof CmcError ? (err.httpStatus === 429 ? 429 : 502) : err instanceof z.ZodError ? 400 : (err as { statusCode?: number }).statusCode ?? 500;
    reply.code(status).send({ error: err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : err.message });
  });

  app.get("/api/status", async () => ({
    mode: mockMode() ? "mock" : "live",
    engine: resolveEngine(),
    anthropicConfigured: hasAnthropicCreds(),
    model: config.anthropicModel,
    adminRequired: Boolean(ADMIN_TOKEN),
    agentRunning: isRunning(),
    scheduler: schedulerState,
    cmc: cmcStats(),
  }));

  app.get("/api/overview", async () => marketOverview());

  app.get("/api/screener", async (req) => {
    const q = req.query as Record<string, string>;
    const snap = await snapshot();
    scanDepegs(snap.rows);
    const rows = filterRows(snap.rows, {
      q: q.q,
      assetType: (q.assetType || undefined) as AssetType | undefined,
      issuer: q.issuer || undefined,
      signal: (q.signal || undefined) as Signal | undefined,
      minVol: num(q.minVol),
      minMcap: num(q.minMcap),
      maxAbsPremium: num(q.maxAbsPremium),
      tradableOnly: q.tradableOnly === "true",
      sort: (q.sort || "score") as never,
      dir: q.dir === "asc" ? "asc" : "desc",
      limit: num(q.limit),
    });
    return { at: snap.at, total: snap.rows.length, count: rows.length, rows };
  });

  app.get("/api/assets/:rwaId", async (req) => {
    const rwaId = Number((req.params as { rwaId: string }).rwaId);
    const q = req.query as Record<string, string>;
    const interval = ["hourly", "daily", "weekly"].includes(q.interval) ? q.interval : "daily";
    const count = Math.min(Number(q.count ?? 90), 365);
    let pairsError: string | null = null;
    const [info, history, pairs, snap] = await Promise.all([
      assetInfo(rwaId).catch(() => null),
      assetHistory(rwaId, interval, count),
      marketPairs(rwaId).catch((err: Error) => {
        pairsError = err.message;
        return [];
      }),
      lastSnapshotRows().length ? Promise.resolve({ rows: lastSnapshotRows() }) : snapshot(),
    ]);
    return { rwaId, info, history, pairs, pairsError, tokens: snap.rows.filter((r) => r.rwaId === rwaId) };
  });

  app.get("/api/issuers", async () => {
    const [snap, directory] = await Promise.all([snapshot(), issuers().catch(() => [])]);
    const card = issuerScorecard(snap.rows);
    const dir = new Map(directory.map((d) => [d.issuer_id, d]));
    return {
      scorecard: card.map((c) => ({ ...c, website: c.issuerId ? dir.get(c.issuerId)?.website ?? null : null, totalTokensListed: c.issuerId ? dir.get(c.issuerId)?.num_tokens ?? null : null })),
      directoryCount: directory.length,
    };
  });

  // ---------- portfolio ----------
  app.get("/api/portfolio", async () => portfolioSummary());
  app.get("/api/orders", async (req) => orderHistory(Number((req.query as { limit?: string }).limit ?? 200)));
  app.get("/api/equity", async () => equityHistory());

  app.post("/api/portfolio/refresh", { preHandler: requireAdmin }, async () => {
    await quickMarkToMarket();
    return portfolioSummary();
  });

  app.post("/api/orders", { preHandler: requireAdmin }, async (req) => {
    const body = z.object({
      cryptoId: z.number().int(),
      side: z.enum(["buy", "sell"]),
      usd: z.number().positive().optional(),
      fraction: z.number().min(0).max(1).optional(),
      reason: z.string().max(400).optional(),
    }).parse(req.body);
    const rows = lastSnapshotRows().length ? lastSnapshotRows() : (await snapshot()).rows;
    const row = rows.find((r) => r.cryptoId === body.cryptoId);
    const pos = portfolioSummary().positions.find((p) => p.cryptoId === body.cryptoId);
    const order = placeOrder(
      {
        cryptoId: body.cryptoId,
        side: body.side,
        usd: body.side === "buy" ? body.usd : null,
        qty: body.side === "sell" && pos ? pos.qty * (body.fraction ?? 1) : null,
        reason: body.reason || "manual order",
        source: "user",
      },
      row,
    );
    if (order.status === "filled") pushAlert("trade", `order:${order.id}`, `Manual ${order.side} ${order.symbol} filled`, `$${order.notional.toFixed(2)} @ ${order.price}`, false);
    return order;
  });

  app.post("/api/orders/:id/approve", { preHandler: requireAdmin }, async (req) => {
    const rows = (await snapshot()).rows;
    const order = approvePending((req.params as { id: string }).id, new Map(rows.map((r) => [r.cryptoId, r])));
    if (order.status === "filled") pushAlert("trade", `order:${order.id}`, `Approved ${order.side} ${order.symbol} filled`, order.reason, false);
    return order;
  });
  app.post("/api/orders/:id/cancel", { preHandler: requireAdmin }, async (req) => {
    cancelPending((req.params as { id: string }).id);
    return { ok: true };
  });
  app.post("/api/portfolio/reset", { preHandler: requireAdmin }, async (req) => {
    const body = z.object({ startingCash: z.number().min(100).max(1e9).optional() }).parse(req.body ?? {});
    resetPortfolio(body.startingCash);
    return portfolioSummary();
  });

  // ---------- agent ----------
  app.get("/api/settings", async () => getSettings());
  app.put("/api/settings", { preHandler: requireAdmin }, async (req) => updateSettings(SettingsSchema.partial().parse(req.body)));

  app.post("/api/agent/run", { preHandler: requireAdmin }, async (_req, reply) => {
    if (isRunning()) return reply.code(409).send({ error: "an agent run is already in progress" });
    // fire and forget; the UI polls the journal
    const p = runAgent("manual").then((run) => pushAlert("agent", `run:${run.id}`, `Agent run ${run.status} (${run.engine})`, run.summary, false));
    p.catch((err) => console.warn("[agent]", err.message));
    await new Promise((r) => setTimeout(r, 150));
    return { started: true, run: listRuns(1)[0] ?? null };
  });
  app.get("/api/agent/runs", async () => listRuns(50));
  app.get("/api/agent/runs/:id", async (req, reply) => getRun((req.params as { id: string }).id) ?? reply.code(404).send({ error: "not found" }));

  // ---------- misc ----------
  app.get("/api/alerts", async () => listAlerts(100));
  app.get("/api/evidence", async () => ({ calls: readEvidence(100), recent: cmcStats().recent }));
  app.get("/api/key-info", async () => (mockMode() ? { mode: "mock" } : keyInfo()));
}
