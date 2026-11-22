/**
 * Claude engine: Claude Opus 5.5 drives the research -> decide -> order loop
 * through tools, using the Anthropic SDK's tool runner. Risk limits are not
 * left to the model: place_order goes through the same code-level checks as
 * every other order, and rejections are returned to Claude as tool results.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "../config.ts";
import { getSettings } from "../settings.ts";
import { step, type AgentRun } from "./journal.ts";
import { toolMarketOverview, toolPlaceOrder, toolPortfolio, toolScreen, toolTokenDetail, type ToolContext } from "./tools.ts";

const SYSTEM = `You are RWA Lens's portfolio agent. You manage a PAPER-TRADING portfolio of tokenized real-world assets (tokenized stocks, ETFs, gold and other commodities, currencies, treasuries, real estate). No real money is at stake, but trade as if it were: the goal is risk-adjusted return, not activity.

Data comes from the CoinMarketCap API:
- Each RWA asset (e.g. NVIDIA, Gold) has several tokens from different issuers that track it. "premium_pct" is a token's price versus a peer reference: the volume-weighted median price of the OTHER tokens tracking the same asset in the same unit. A negative value means the token trades at a discount to its siblings; a large positive value means it is rich. A null premium means the token uses a different unit (e.g. gold per gram vs per ounce) and cannot be compared.
- change_*_pct fields are token-level momentum. vol_24h_usd and turnover measure liquidity; thin tokens are expensive to trade (the simulator charges slippage that grows with order size relative to 24h volume, plus a 10 bps fee).
- Tokenized stocks and ETFs trade 24/7 while their underlying markets close, so weekend moves can be noise that reverts.
- Signals: DISCOUNT, PREMIUM, MOMENTUM_UP, MOMENTUM_DOWN, REBOUND, ILLIQUID, UNIT_MISMATCH, LEVERAGED (leveraged or inverse ETF: decays over time, blocked when avoidLeveraged is on).

How to work each run:
1. Call get_portfolio first, then get_market_overview.
2. Review open positions. Sell when the thesis is broken (momentum has turned against you, the token now trades at a meaningful premium you can harvest, or a better use of capital exists). Stop-loss and take-profit exits also run automatically in code.
3. Use screen_tokens to find candidates and get_token_detail on the few you are seriously considering. Prefer liquid tokens and, among tokens tracking the same asset, the one at the best price.
4. Place orders only when you have a specific reason. Doing nothing is a valid outcome. Size positions with the limits returned by get_portfolio in mind; the risk engine rejects orders that break them and tells you why.
5. Finish with a short plain-text summary (under 120 words): what you did, why, and what you would watch next run.

The user may add strategy notes in their message. Follow them unless they conflict with the risk limits.`;

export async function runClaude(run: AgentRun, ctx: ToolContext) {
  const client = new Anthropic();
  const settings = getSettings();

  const tools = [
    betaZodTool({
      name: "get_portfolio",
      description: "Current paper portfolio: cash, equity, open positions with P&L, pending orders, and the risk limits every order must respect.",
      inputSchema: z.object({}),
      run: async () => log(run, "get_portfolio", {}, toolPortfolio()),
    }),
    betaZodTool({
      name: "get_market_overview",
      description: "Market context: tokenized RWA market cap and volume, total crypto market cap and 24h change, BTC dominance, RWA share of crypto, breakdown by asset type, and how many tokens deviate 1%+ from their asset reference.",
      inputSchema: z.object({}),
      run: async () => log(run, "get_market_overview", {}, await toolMarketOverview()),
    }),
    betaZodTool({
      name: "screen_tokens",
      description: "Screen the tokenized-RWA universe. Returns tokens with price, premium/discount vs asset reference, 1h/24h/7d/30d change, market cap, 24h volume, a 0-100 composite score and signal tags. Defaults to tokens above the minimum-volume limit, sorted by score.",
      inputSchema: z.object({
        asset_type: z.enum(["stock", "commodity", "currency", "government_security", "etf", "real_estate"]).optional(),
        signal: z.enum(["DISCOUNT", "PREMIUM", "MOMENTUM_UP", "MOMENTUM_DOWN", "REBOUND", "ILLIQUID", "UNIT_MISMATCH", "LEVERAGED"]).optional(),
        min_vol_24h: z.number().optional().describe("Minimum 24h USD volume; defaults to the risk limit"),
        query: z.string().optional().describe("Text match on symbol, name, asset or issuer"),
        sort: z.enum(["score", "change24h", "change7d", "premiumPct", "vol24h", "mcap"]).optional(),
        direction: z.enum(["asc", "desc"]).optional(),
        limit: z.number().int().min(1).max(30).optional(),
      }),
      run: async (input) => log(run, "screen_tokens", input, toolScreen(ctx, input)),
    }),
    betaZodTool({
      name: "get_token_detail",
      description: "Deep dive on one token by crypto_id: its metrics, sibling tokens tracking the same asset (to compare prices across issuers), the asset's 30-day history (return, daily volatility, drawdown) and its most liquid market pairs.",
      inputSchema: z.object({ crypto_id: z.number().int() }),
      run: async (input) => log(run, "get_token_detail", input, await toolTokenDetail(ctx, input.crypto_id)),
    }),
    betaZodTool({
      name: "place_order",
      description: "Place a paper order. Buys take usd_amount; sells take sell_fraction (0-1, default 1 = close the position). Always include a one-sentence reason. Orders are checked against the risk limits; a rejection explains which limit was hit. When autopilot is off the order is queued for user approval instead of filling.",
      inputSchema: z.object({
        crypto_id: z.number().int(),
        side: z.enum(["buy", "sell"]),
        usd_amount: z.number().positive().optional(),
        sell_fraction: z.number().min(0).max(1).optional(),
        reason: z.string().min(3).max(400),
      }),
      run: async (input) => {
        const res = toolPlaceOrder(ctx, input);
        step(run, "order", `${input.side.toUpperCase()} ${res.symbol}: ${res.status}${res.reject_reason ? ` (${res.reject_reason})` : ""}`, { input, result: res });
        return JSON.stringify(res);
      },
    }),
  ];

  const now = new Date().toISOString();
  const userMsg = [
    `Run time: ${now}. Autopilot: ${settings.autopilot ? "ON (orders fill immediately)" : "OFF (orders are queued for my approval)"}.`,
    `You may place at most ${settings.maxOrdersPerRun} orders this run.`,
    settings.strategyNotes ? `My strategy notes:\n${settings.strategyNotes}` : "No extra strategy notes this time.",
    "Review the portfolio and the market, then act.",
  ].join("\n\n");

  const runner = client.beta.messages.toolRunner({
    model: config.anthropicModel,
    max_tokens: 16000,
    max_iterations: 14,
    thread: false,
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "medium" },
    // Server-side refusal fallback: if the model declines, the API reroutes the same request.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    // Stable prefix (tools + system) is cached across runs.
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral", ttl: "1h" } }],
    tools,
    messages: [{ role: "user", content: userMsg }],
  });

  const usage = { input: 0, output: 0, cacheRead: 0 };
  let finalText = "";
  let lastStop: string | null = null;
  for await (const message of runner) {
    usage.input += message.usage.input_tokens;
    usage.output += message.usage.output_tokens;
    usage.cacheRead += message.usage.cache_read_input_tokens ?? 0;
    lastStop = message.stop_reason;
    for (const block of message.content) {
      if (block.type === "thinking" && block.thinking) step(run, "thinking", "Reasoning", block.thinking);
      else if (block.type === "text" && block.text.trim()) {
        step(run, "text", "Claude", block.text);
        finalText = block.text;
      } else if (block.type === "tool_use") step(run, "tool_call", `→ ${block.name}`, block.input);
    }
  }
  run.usage = usage;
  if (lastStop === "refusal") throw new Error("Claude declined this run (stop_reason: refusal)");
  if (lastStop === "tool_use") finalText ||= "Stopped at the iteration limit before writing a summary.";
  return finalText || "No summary returned.";
}

function log(run: AgentRun, name: string, input: unknown, result: unknown) {
  const text = JSON.stringify(result);
  step(run, "tool_result", `${name} result`, { input, bytes: text.length, preview: text.slice(0, 600) });
  return text;
}
