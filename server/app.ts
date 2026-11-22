/**
 * REST API as a Hono app. The same app runs on Node (server/index.ts, via
 * @hono/node-server) and on Cloudflare Pages (server/worker.ts, as _worker.js).
 */
import { Hono, type Context, type Next } from "hono";
import { z } from "zod";
import { getRun, isRunning, listRuns } from "./agent/journal.ts";
import { runAgent } from "./agent/run.ts";
import { listAlerts, pushAlert, scanDepegs } from "./alerts.ts";
import { CmcError, cmcStats, readEvidence } from "./cmc.ts";
import { config, mockMode } from "./config.ts";
import { approvePending, cancelPending, equityHistory, orderHistory, placeOrder, portfolioSummary, resetPortfolio } from "./portfolio.ts";
import { assetHistory, assetInfo, issuers, keyInfo, marketPairs, type AssetType } from "./rwa.ts";
import { quickMarkToMarket, schedulerStatus, tick } from "./scheduler.ts";
import { filterRows, issuerScorecard, lastSnapshotRows, marketOverview, snapshot, type Signal } from "./screener.ts";
import { getSettings, SettingsSchema, updateSettings } from "./settings.ts";

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Mutating routes require x-admin-token when ADMIN_TOKEN is set (public deploys). */
async function requireAdmin(c: Context, next: Next) {
  if (config.adminToken && c.req.header("x-admin-token") !== config.adminToken) {
    return c.json({ error: "admin token required for this action" }, 401);
  }
  await next();
}

const num = (v: string | undefined) => (v === undefined || v === "" ? undefined : Number(v));
const body = async (c: Context) => {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
};

export function createApp() {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof z.ZodError) return c.json({ error: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
    if (err instanceof CmcError) return c.json({ error: err.message }, err.httpStatus === 429 ? 429 : 502);
    console.error("[api]", err);
    return c.json({ error: err.message || "internal error" }, 500);
  });

  app.get("/api/status", (c) =>
    c.json({
      mode: mockMode() ? "mock" : "live",
      platform: config.platform,
      persistent: config.persistent,
      strategy: getSettings().strategy,
      adminRequired: Boolean(config.adminToken),
      agentRunning: isRunning(),
      scheduler: schedulerStatus(),
      cmc: cmcStats(),
    }),
  );

  app.get("/api/overview", async (c) => c.json(await marketOverview()));

  app.get("/api/screener", async (c) => {
    const q = c.req.query();
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
    return c.json({ at: snap.at, total: snap.rows.length, count: rows.length, rows });
  });

  app.get("/api/assets/:rwaId", async (c) => {
    const rwaId = Number(c.req.param("rwaId"));
    if (!Number.isInteger(rwaId)) throw new HttpError(400, "invalid asset id");
    const q = c.req.query();
    const interval = ["hourly", "daily", "weekly"].includes(q.interval ?? "") ? q.interval! : "daily";
    const count = Math.min(Number(q.count ?? 90) || 90, 365);
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
    return c.json({ rwaId, info, history, pairs, pairsError, tokens: snap.rows.filter((r) => r.rwaId === rwaId) });
  });

  app.get("/api/issuers", async (c) => {
    const [snap, directory] = await Promise.all([snapshot(), issuers().catch(() => [])]);
    const dir = new Map(directory.map((d) => [d.issuer_id, d]));
    return c.json({
      scorecard: issuerScorecard(snap.rows).map((x) => ({
        ...x,
        website: x.issuerId ? dir.get(x.issuerId)?.website ?? null : null,
        totalTokensListed: x.issuerId ? dir.get(x.issuerId)?.num_tokens ?? null : null,
      })),
      directoryCount: directory.length,
    });
  });

  // ---------- portfolio ----------
  app.get("/api/portfolio", (c) => c.json(portfolioSummary()));
  app.get("/api/orders", (c) => c.json(orderHistory(Number(c.req.query("limit") ?? 200) || 200)));
  app.get("/api/equity", (c) => c.json(equityHistory()));

  app.post("/api/portfolio/refresh", requireAdmin, async (c) => {
    await quickMarkToMarket();
    return c.json(portfolioSummary());
  });

  app.post("/api/orders", requireAdmin, async (c) => {
    const b = z
      .object({
        cryptoId: z.number().int(),
        side: z.enum(["buy", "sell"]),
        usd: z.number().positive().optional(),
        fraction: z.number().min(0).max(1).optional(),
        reason: z.string().max(400).optional(),
      })
      .parse(await body(c));
    const rows = lastSnapshotRows().length ? lastSnapshotRows() : (await snapshot()).rows;
    const row = rows.find((r) => r.cryptoId === b.cryptoId);
    const pos = portfolioSummary().positions.find((p) => p.cryptoId === b.cryptoId);
    const order = placeOrder(
      {
        cryptoId: b.cryptoId,
        side: b.side,
        usd: b.side === "buy" ? b.usd : null,
        qty: b.side === "sell" && pos ? pos.qty * (b.fraction ?? 1) : null,
        reason: b.reason || "manual order",
        source: "user",
      },
      row,
    );
    if (order.status === "filled") pushAlert("trade", `order:${order.id}`, `Manual ${order.side} ${order.symbol} filled`, `$${order.notional.toFixed(2)} @ ${order.price}`, false);
    return c.json(order);
  });

  app.post("/api/orders/:id/approve", requireAdmin, async (c) => {
    const rows = (await snapshot()).rows;
    let order;
    try {
      order = approvePending(c.req.param("id") ?? "", new Map(rows.map((r) => [r.cryptoId, r])));
    } catch (err) {
      throw new HttpError(404, (err as Error).message);
    }
    if (order.status === "filled") pushAlert("trade", `order:${order.id}`, `Approved ${order.side} ${order.symbol} filled`, order.reason, false);
    return c.json(order);
  });
  app.post("/api/orders/:id/cancel", requireAdmin, (c) => {
    cancelPending(c.req.param("id") ?? "");
    return c.json({ ok: true });
  });
  app.post("/api/portfolio/reset", requireAdmin, async (c) => {
    const b = z.object({ startingCash: z.number().min(100).max(1e9).optional() }).parse(await body(c));
    resetPortfolio(b.startingCash);
    return c.json(portfolioSummary());
  });

  // ---------- agent ----------
  app.get("/api/settings", (c) => c.json(getSettings()));
  app.put("/api/settings", requireAdmin, async (c) => c.json(updateSettings(SettingsSchema.partial().parse(await body(c)))));

  app.post("/api/agent/run", requireAdmin, async (c) => {
    if (isRunning()) return c.json({ error: "an agent run is already in progress" }, 409);
    const job = runAgent("manual").then((run) => {
      pushAlert("agent", `run:${run.id}`, `Agent run ${run.status} (${run.strategy})`, run.summary, false);
      return run;
    });
    if (config.platform === "cloudflare") {
      // Workers persist state at the end of the request, so finish the run first.
      const run = await job;
      return c.json({ started: true, run: listRuns(1)[0] ?? null, status: run.status });
    }
    // Node: fire and forget; the UI polls the journal
    job.catch((err) => console.warn("[agent]", err.message));
    await new Promise((r) => setTimeout(r, 150));
    return c.json({ started: true, run: listRuns(1)[0] ?? null });
  });
  app.get("/api/agent/runs", (c) => c.json(listRuns(50)));
  app.get("/api/agent/runs/:id", (c) => {
    const run = getRun(c.req.param("id"));
    return run ? c.json(run) : c.json({ error: "not found" }, 404);
  });

  /** Run whatever scheduled job is due. For platforms without timers (Cloudflare): point a cron at it. */
  app.post("/api/cron", requireAdmin, async (c) => c.json({ ran: await tick() }));

  // ---------- misc ----------
  app.get("/api/alerts", (c) => c.json(listAlerts(100)));
  app.get("/api/evidence", (c) => c.json({ calls: readEvidence(60), recent: cmcStats().recent }));
  app.get("/api/key-info", async (c) => c.json(mockMode() ? { mode: "mock" } : await keyInfo()));

  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));
  return app;
}
