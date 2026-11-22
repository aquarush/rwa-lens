# Architecture

How RWA Lens turns CoinMarketCap data into a screener, a peg monitor and a rule-based paper-trading agent. No LLM or external AI service is involved anywhere.

## Overview

```
                 ┌──────────────────────── server/ (Fastify · Node 22 · TypeScript) ─────────────────────────┐
                 │                                                                                           │
 CMC Pro API ──▶ │  cmc.ts        key stays server-side · TTL cache · evidence log · daily credit budget     │
                 │                mock layer (mock.ts) when no key · fixture recording                      │
                 │  rwa.ts        typed endpoint wrappers · cleans live-data quirks                          │
                 │  screener.ts   peer pricing · signals · score · issuer scorecard · market overview        │
                 │  portfolio.ts  paper engine: fills · fees · slippage · risk checks · stops               │
                 │  agent/        strategy.ts (decision loop) · tools.ts · journal.ts · run.ts               │
                 │  scheduler.ts  agent on an interval · cheap mark-to-market                                │
                 │  alerts.ts     de-pegs · exits · agent runs (+ Telegram)                                  │
                 │  routes.ts     REST API                       store.ts  JSON persistence in DATA_DIR     │
                 └───────────────▲─────────────────────────────────────▲─────────────────────────────────────┘
                                 │ /api                                 │ shared tools (agent/tools.ts)
                       web/ (Vite · TS · Chart.js)               mcp/server.ts (MCP over stdio)
```

Everything shares one implementation. The web UI, the trading agent and the MCP server all call the same screener and tool functions, and every order goes through the same `placeOrder()` → `riskCheck()` path.

## Data flow for one snapshot

1. `GET /v5/real-world-assets/assets/list?sort=tokenized_market_cap&sort_dir=desc&limit=60` gives the top tokenized assets. Rows with a null `rwa_id` are dropped.
2. `GET /v5/real-world-assets/quotes/latest?rwa_id=…` (one call for all 60) gives the **tokens** tracking each asset: issuer, price, market cap and volume. Placeholder rows (null symbol or price) and dead rows (zero cap and zero volume, e.g. "Derivatives" references) are dropped.
3. `GET /v2/cryptocurrency/quotes/latest?id=…` (chunks of 100 `crypto_id`s) adds token-level 1h/24h/7d/30d change and fresher prices.
4. `scoreTokens()` computes peer pricing, signals and score.

The cost is about 6-8 credits, cached for 60 seconds. `GET /v1/global-metrics/quotes/latest` (cached for 5 minutes) adds total crypto market cap for the RWA share.

## Peer pricing

The question is: *is this token cheap or rich compared with the other tokens tracking the same asset?*

CMC's `average_tokenized_price` can't answer that on live data, because tokens within one asset can use different units. For example, two SanDisk tokens trade at about $655 and five at about $82, which pulls the average to $87.7 and makes every real token look 6% cheap. So, per asset:

1. **Find the unit.** Take the volume-weighted median price across the asset's tokens (weight = 24h volume + 1% of market cap). That anchors on the most-traded unit.
2. **Keep comparable siblings.** Tokens priced −20% / +25% of the anchor share its unit. The rest get `UNIT_MISMATCH` and no premium.
3. **Leave-one-out reference.** Each comparable token is priced against the volume-weighted median of the *other* comparable tokens. Including itself would pin the most-traded token at exactly 0%.

`premiumPct = price / refPrice − 1`. A single token with no comparable siblings has no premium.

## Signals and score

| Signal | Rule |
|---|---|
| `DISCOUNT` / `PREMIUM` | ≥ 0.5% below / above peers |
| `MOMENTUM_UP` / `MOMENTUM_DOWN` | 24h ≥ +2% with 7d ≥ 0 / 24h ≤ −2% with 7d ≤ 0 |
| `REBOUND` | 7d ≤ −8% and 24h > +0.5% |
| `ILLIQUID` | 24h volume < $250k |
| `UNIT_MISMATCH` | priced in a different unit from its siblings |
| `LEVERAGED` | leveraged or inverse ETF (ticker list + name pattern) |

**Score (0-100)** = 30% liquidity (log 24h volume) + 30% momentum (tanh of 24h and 7d) + 25% value vs peers + 15% size (log market cap).

## Paper trading engine (`portfolio.ts`)

- **Fill price** is the latest CMC price ± slippage, where slippage = 5 bps + 10 bps per 1% of the token's 24h volume, capped at 2%. The fee is 10 bps per fill.
- **Risk checks** run on every order, whoever places it:
  - kill switch;
  - max position % of equity, max gross exposure, minimum cash %;
  - minimum trade size and minimum 24h volume;
  - no buying above the max premium vs peers;
  - allowed asset types, blocked symbols, leveraged/inverse block;
  - max orders per agent run.
- **Pending orders.** With autopilot off, agent orders are validated and queued. Approving re-validates and fills at the current price.
- **Mark-to-market** happens every 10 minutes while positions are open. It quotes only the held tokens (1 credit per 100), records an equity point, and fires stop-loss and take-profit exits as `risk` orders.

## The agent (`agent/`)

`run.ts` takes a snapshot, marks positions to market (which can fire stop-loss and take-profit exits), runs the strategy and journals everything.

### Decision loop (`strategy.ts`)

All inputs come from CoinMarketCap; the logic is plain, deterministic TypeScript.

1. **Market regime** from `/v1/global-metrics/quotes/latest` (total crypto market cap 24h change):

   | Regime | Condition | Effect |
   |---|---|---|
   | risk-off | ≤ −3% | new sizes ×0.5, no momentum entries, cut losers below −4% |
   | neutral | between | sizes ×0.85 |
   | risk-on | ≥ +2% | full size |

2. **Position review.** Sell when momentum turns down while under water (< −2%), harvest a premium > 1.5% vs peers while in profit, or cut losers in risk-off. Otherwise hold, and log why.
3. **Screen.** Keep tokens that pass all of these, and count the reason for every rejection:
   - liquid (≥ min volume), allowed asset type, not leveraged;
   - not PREMIUM or MOMENTUM_DOWN;
   - has a signal of the chosen style (*balanced*: DISCOUNT/MOMENTUM_UP/REBOUND · *momentum*: MOMENTUM_UP · *value*: DISCOUNT/REBOUND);
   - score ≥ min score, and not already held.

   Then keep the best-priced sibling per asset and shortlist up to 2× the per-run order limit.
4. **Research** each shortlisted asset with `/v5/real-world-assets/quotes/historical` (30 daily points): 30-day return, daily volatility (stdev of log returns) and drawdown from the 30-day high.
   - Skip **falling knives**: drawdown < −25% without a REBOUND signal.
   - Skip anything with daily volatility > 8%.
5. **Sizing.** Base size is half the max position. It's scaled by a volatility target (2% daily vol target; multiplier clamped 0.4-1.5×) and the regime multiplier, and capped by the position limit and available cash above the cash floor. Orders go through `riskCheck()`; rejections are journaled.

The pure parts (`regimeFrom`, `volTargetSize`, `historyStats`) are unit-tested.

### Journal

Every run records:
- the snapshot info and each tool call and result (with a preview);
- the market regime, filter counts, and the reasoning behind every hold, skip, buy and sell;
- every order with its status or rejection reason;
- equity before and after, and token usage.

The UI polls the journal while a run is in progress.

## Credit discipline

| Mechanism | Where |
|---|---|
| TTL cache per request (60s quotes, 5 min history and global, 30 min metadata) | `cmc.ts` |
| In-flight de-duplication (concurrent identical requests share one fetch) | `cmc.ts` |
| Daily budget, persisted across restarts; serves stale cache when exhausted | `cmc.ts` (`CMC_DAILY_CREDIT_BUDGET`) |
| Re-pricing quotes held tokens only | `scheduler.ts` |
| Remembers plan-restricted endpoints (error 1006) and stops calling them | `rwa.ts` |

## Persistence

Plain JSON files in `DATA_DIR` (default `./data`), written atomically (temp file + rename):
- `portfolio.json`: cash, positions, orders, equity history
- `settings.json`: agent and risk settings
- `agent-runs.json`: last 200 runs with journals
- `alerts.json`
- `credits.json`: today's credit spend, shared by the app and the MCP server

The app is the single owner of portfolio state. The MCP server reads and trades through the app's HTTP API instead of writing the file.

## Security

- The CMC key is only ever sent as a request header from the server. Evidence lines store `<redacted>`.
- `ADMIN_TOKEN`, when set, is required (`x-admin-token` header) for every mutating route: orders, approvals, settings, agent runs, reset. Set it on any public deploy, or visitors can spend your credits.
- Paper trading only: there is no code path that sends an order to an exchange.
