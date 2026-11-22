import Anthropic from "@anthropic-ai/sdk";
import { config, hasAnthropicCreds } from "../config.ts";
import { markToMarket, portfolioSummary } from "../portfolio.ts";
import { snapshot } from "../screener.ts";
import { getSettings } from "../settings.ts";
import { runClaude } from "./claude.ts";
import { isRunning, save, startRun, step } from "./journal.ts";
import { runRules } from "./rules.ts";
import type { ToolContext } from "./tools.ts";

export function resolveEngine(): "claude" | "rules" {
  const e = getSettings().engine;
  if (e === "auto") return hasAnthropicCreds() ? "claude" : "rules";
  return e;
}

export async function runAgent(trigger: "manual" | "schedule") {
  if (isRunning()) throw new Error("an agent run is already in progress");
  const settings = getSettings();
  if (settings.killSwitch) throw new Error("kill switch is on; turn it off in Agent settings to run");

  const engine = resolveEngine();
  const run = startRun(trigger, engine, engine === "claude" ? config.anthropicModel : undefined);
  try {
    const snap = await snapshot();
    const byId = new Map(snap.rows.map((r) => [r.cryptoId, r]));
    const exits = markToMarket(byId);
    run.equityBefore = portfolioSummary().equity;
    step(run, "info", `Snapshot: ${snap.rows.length} tokens across ${snap.assets.length} assets`, { at: snap.at });
    for (const o of exits) step(run, "order", `Risk exit ${o.symbol}: ${o.status}`, o);

    const ctx: ToolContext = { rows: snap.rows, byId, runId: run.id, pending: !settings.autopilot, ordersThisRun: [] };
    run.summary = engine === "claude" ? await runClaude(run, ctx) : runRules(run, ctx);
    run.orderIds = ctx.ordersThisRun.map((o) => o.id);
    run.status = "done";
  } catch (err) {
    run.status = "error";
    const msg =
      err instanceof Anthropic.AuthenticationError ? "Anthropic authentication failed - check ANTHROPIC_API_KEY"
      : err instanceof Anthropic.RateLimitError ? "Anthropic rate limit hit - try again shortly"
      : err instanceof Anthropic.APIError ? `Anthropic API error ${err.status}: ${err.message}`
      : (err as Error).message;
    run.summary = msg;
    step(run, "error", msg);
  } finally {
    run.equityAfter = portfolioSummary().equity;
    run.finishedAt = new Date().toISOString();
    save(run);
  }
  return run;
}
