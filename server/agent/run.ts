import { markToMarket, portfolioSummary } from "../portfolio.ts";
import { snapshot } from "../screener.ts";
import { getSettings } from "../settings.ts";
import { isRunning, save, startRun, step } from "./journal.ts";
import { runStrategy } from "./strategy.ts";
import type { ToolContext } from "./tools.ts";

export async function runAgent(trigger: "manual" | "schedule") {
  if (isRunning()) throw new Error("an agent run is already in progress");
  const settings = getSettings();
  if (settings.killSwitch) throw new Error("kill switch is on; turn it off in Agent settings to run");

  const run = startRun(trigger, settings.strategy);
  try {
    const snap = await snapshot();
    const byId = new Map(snap.rows.map((r) => [r.cryptoId, r]));
    const exits = markToMarket(byId);
    run.equityBefore = portfolioSummary().equity;
    step(run, "info", `Snapshot: ${snap.rows.length} tokens across ${snap.assets.length} assets`, { at: snap.at });
    for (const o of exits) step(run, "order", `Risk exit ${o.symbol}: ${o.status}`, o);

    const ctx: ToolContext = { rows: snap.rows, byId, runId: run.id, pending: !settings.autopilot, ordersThisRun: [] };
    run.summary = await runStrategy(run, ctx);
    run.orderIds = ctx.ordersThisRun.map((o) => o.id);
    run.status = "done";
  } catch (err) {
    run.status = "error";
    run.summary = (err as Error).message;
    step(run, "error", run.summary);
  } finally {
    run.equityAfter = portfolioSummary().equity;
    run.finishedAt = new Date().toISOString();
    save(run);
  }
  return run;
}
