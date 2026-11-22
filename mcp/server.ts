/**
 * RWA Lens MCP server (stdio). Gives Claude Desktop / Claude Code / any MCP
 * client the same research tools the trading agent uses, plus read/trade
 * access to the paper portfolio through the running RWA Lens app.
 *
 * Research tools call CoinMarketCap directly (same client, cache and evidence log).
 * Portfolio tools go through the app's HTTP API (RWA_LENS_URL, default
 * http://localhost:8787) so the app remains the single owner of portfolio state.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { compactRow, toolMarketOverview, toolScreen, toolTokenDetail, type ToolContext } from "../server/agent/tools.ts";
import { issuerScorecard, snapshot } from "../server/screener.ts";

const APP = process.env.RWA_LENS_URL ?? "http://localhost:8787";
const ADMIN = process.env.ADMIN_TOKEN ?? "";

const server = new McpServer({ name: "rwa-lens", version: "0.1.0" });

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 1) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });

async function ctx(): Promise<ToolContext> {
  const snap = await snapshot();
  return { rows: snap.rows, byId: new Map(snap.rows.map((r) => [r.cryptoId, r])), runId: "mcp", pending: true, ordersThisRun: [] };
}

async function app(path: string, init?: RequestInit) {
  const res = await fetch(APP + path, {
    ...init,
    headers: { "content-type": "application/json", ...(ADMIN ? { "x-admin-token": ADMIN } : {}), ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json();
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body;
}

server.registerTool(
  "rwa_market_overview",
  {
    description: "Tokenized real-world-asset market overview from CoinMarketCap: RWA tokenized market cap and volume, share of total crypto market cap, BTC dominance, breakdown by asset type (stocks, ETFs, commodities...), and count of tokens deviating from their peers.",
    annotations: { readOnlyHint: true },
  },
  async () => json(await toolMarketOverview()),
);

server.registerTool(
  "rwa_screen",
  {
    description: "Screen tokenized RWAs (tokenized stocks, ETFs, gold, etc.). Each token has price, premium/discount vs sibling tokens tracking the same asset, 1h/24h/7d/30d change, market cap, 24h volume, a 0-100 score and signal tags (DISCOUNT, PREMIUM, MOMENTUM_UP, MOMENTUM_DOWN, REBOUND, ILLIQUID, UNIT_MISMATCH, LEVERAGED).",
    inputSchema: {
      asset_type: z.enum(["stock", "commodity", "currency", "government_security", "etf", "real_estate"]).optional(),
      signal: z.enum(["DISCOUNT", "PREMIUM", "MOMENTUM_UP", "MOMENTUM_DOWN", "REBOUND", "ILLIQUID", "UNIT_MISMATCH", "LEVERAGED"]).optional(),
      query: z.string().optional().describe("Match symbol, name, underlying asset or issuer, e.g. 'NVDA' or 'Ondo'"),
      min_vol_24h: z.number().optional(),
      sort: z.enum(["score", "change24h", "change7d", "premiumPct", "vol24h", "mcap"]).optional(),
      direction: z.enum(["asc", "desc"]).optional(),
      limit: z.number().int().min(1).max(30).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async (input) => json(toolScreen(await ctx(), { ...input, min_vol_24h: input.min_vol_24h ?? 0 })),
);

server.registerTool(
  "rwa_token_detail",
  {
    description: "Deep dive on one tokenized asset token by its CoinMarketCap crypto_id (get ids from rwa_screen): metrics, sibling tokens from other issuers, the underlying asset's 30-day history and its most liquid market pairs.",
    inputSchema: { crypto_id: z.number().int() },
    annotations: { readOnlyHint: true },
  },
  async ({ crypto_id }) => json(await toolTokenDetail(await ctx(), crypto_id)),
);

server.registerTool(
  "rwa_peg_check",
  {
    description: "Find tokens trading away from their peers: for each underlying asset, compares every issuer's token to the volume-weighted median of its siblings. Answers questions like 'which tokenized NVIDIA is cheapest?' or 'is any gold token de-pegged?'.",
    inputSchema: {
      query: z.string().optional().describe("Limit to an asset/issuer, e.g. 'GOLD' or 'Backed'"),
      min_abs_pct: z.number().optional().describe("Only show deviations at least this large (default 0.5)"),
      liquid_only: z.boolean().optional().describe("Only tokens with meaningful 24h volume (default true)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query, min_abs_pct = 0.5, liquid_only = true }) => {
    const { rows } = await ctx();
    const q = query?.toLowerCase();
    const hits = rows
      .filter((r) => r.premiumPct != null && Math.abs(r.premiumPct) >= min_abs_pct)
      .filter((r) => !liquid_only || r.tradable)
      .filter((r) => !q || [r.symbol, r.assetSymbol, r.assetName, r.issuerName].some((v) => v?.toLowerCase().includes(q)))
      .sort((a, b) => Math.abs(b.premiumPct!) - Math.abs(a.premiumPct!))
      .slice(0, 25);
    return json({ count: hits.length, tokens: hits.map((r) => ({ ...compactRow(r), peers: r.peers })) });
  },
);

server.registerTool(
  "rwa_issuer_report",
  {
    description: "Issuer scorecard: for each tokenization issuer (Backed/xStocks, Ondo, Paxos, Tether, bStocks, Robinhood...), number of tokens, underlying assets covered, total market cap, 24h volume, turnover and average absolute deviation from peers (peg tightness).",
    inputSchema: { query: z.string().optional().describe("Filter by issuer name") },
    annotations: { readOnlyHint: true },
  },
  async ({ query }) => {
    const { rows } = await ctx();
    let card = issuerScorecard(rows);
    if (query) card = card.filter((c) => c.issuer.toLowerCase().includes(query.toLowerCase()));
    return json(card.slice(0, 30));
  },
);

server.registerTool(
  "portfolio_get",
  {
    description: "The RWA Lens paper-trading portfolio (simulated, no real money): equity, cash, P&L, open positions and orders awaiting approval. Requires the RWA Lens app to be running.",
    annotations: { readOnlyHint: true },
  },
  async () => {
    try {
      return json(await app("/api/portfolio"));
    } catch (err) {
      return fail(`RWA Lens app not reachable at ${APP}: ${(err as Error).message}`);
    }
  },
);

server.registerTool(
  "paper_order",
  {
    description: "Place a PAPER (simulated) order in the RWA Lens portfolio. Buys take usd; sells take fraction of the position (default 1 = close). Orders pass the app's risk limits and may be rejected with a reason. No real trade is ever made.",
    inputSchema: {
      crypto_id: z.number().int(),
      side: z.enum(["buy", "sell"]),
      usd: z.number().positive().optional(),
      fraction: z.number().min(0).max(1).optional(),
      reason: z.string().max(400).optional(),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  async ({ crypto_id, side, usd, fraction, reason }) => {
    try {
      return json(await app("/api/orders", { method: "POST", body: JSON.stringify({ cryptoId: crypto_id, side, usd, fraction, reason: reason ?? "via MCP" }) }));
    } catch (err) {
      return fail(`Order failed: ${(err as Error).message}`);
    }
  },
);

await server.connect(new StdioServerTransport());
console.error(`rwa-lens MCP server ready (portfolio via ${APP})`);
