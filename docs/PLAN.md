# RWA Lens — Build Plan (CMC API Hackathon Round 2, #BuildwithCMC)

**Deadline:** Wed 9 Dec 2026, 23:59 UTC. **Track:** Real World Assets (main), with an MCP server bonus that also fits the AI Agents track.

## Why this wins
- RWA endpoints are **new**. CMC is pushing them, and the RWA track will have fewer entries than the crowded "AI bot" or "dashboard" tracks.
- Scoring: Works 30 · Useful 25 · Interesting API use 20 · Code/docs 15 · Presentation 10.
- We combine RWA endpoints with the classic crypto endpoints, which counts as "interesting use". The same core is exposed in three ways (web dashboard, MCP tools for Claude/LLMs, alert bot), which counts as "useful".
- Built-in **evidence logging**: every real API call is saved (with the key redacted) to `evidence/`. That covers the "visible evidence of a real API call" requirement.

## What it is
A research and monitoring tool for tokenised real-world assets (treasuries, equities, commodities, funds):
1. **Explorer**: browse RWA tokens by category and issuer, with market cap, volume, chains and price.
2. **Peg / NAV deviation monitor**: compare a token's price against its reference (e.g. a gold token vs. gold, a treasury fund vs. $1/NAV) and flag de-pegs.
3. **Issuer scorecard**: how many products each issuer has, their total market cap and liquidity (volume / mcap), and how many chains they span.
4. **RWA vs. crypto comparison**: RWA market-cap share against total crypto market cap (global-metrics), plus the "flight to safety" signal when the treasury share grows while BTC falls.
5. **MCP server**: tools `rwa_search`, `rwa_issuer_report`, `rwa_peg_check` and `rwa_market_share`, so Claude Desktop or Code can answer "which tokenised treasury has the most liquidity?"
6. **Alerts** (optional, Telegram): a de-peg above X% or a liquidity drop.

## Stack (keep it simple, no build step headaches)
- Node 22 + TypeScript (tsx), **Fastify** server that proxies CMC so the key stays server-side, with an in-memory TTL cache to save credits
- `web/`: a single-page Vite + vanilla TS (or Preact) frontend with Chart.js
- `mcp/`: `@modelcontextprotocol/sdk` stdio server that reuses `server/cmc.ts`
- `evidence/`: JSONL log of request URL, params, status, credits used and a truncated response
- Mock mode: `fixtures/` serve recorded responses when there's no key, so judges can run it anyway

## Endpoints to use (verify exact paths/fields in docs first!)
- RWA endpoints: https://coinmarketcap.com/api/documentation/pro-api-reference/real-world-assets (**read this first tomorrow**)
- `/v1/cryptocurrency/listings/latest`, `/v2/cryptocurrency/quotes/latest`, `/v2/cryptocurrency/info`
- `/v1/global-metrics/quotes/latest`
- `/v1/cryptocurrency/categories` + `/v1/cryptocurrency/category` (RWA category fallback)
- `/v3/cryptocurrency/quotes/historical` or OHLCV if the tier allows (for sparklines)
- `/v1/key/info` (shows credits used, good for the evidence screenshot)

## Scope update (22 Nov): screener + AI paper-trading agent + management UI
Added at the user's request: an **AI agent that trades** (paper only: CMC has no execution, and real money is out of scope), a **screener**, and a full **web app to manage it all**. Built and working against the live API:
- [x] CMC client: cache, evidence log, daily credit budget, mock mode, fixture recording
- [x] Screener: peer-relative pricing (volume-weighted median of siblings, excluding self), unit-mismatch detection, signals, score
- [x] Paper engine: fees, slippage, risk checks, stop-loss/take-profit, approval queue
- [x] Agent: Claude (tool runner) + rule-engine fallback, journal, scheduler, alerts (+Telegram)
- [x] Web UI: dashboard, screener, asset detail, agent console, portfolio, issuers, alerts, API evidence
- [x] MCP server (7 tools), tests, README, docs/API_FEEDBACK.md
- [ ] Add ANTHROPIC_API_KEY and do a live Claude agent run (only the rule engine has run so far)
- [ ] `npm run record` for a real mock snapshot (~65 credits); decide whether to commit fixtures
- [ ] Deploy with ADMIN_TOKEN set, demo video, X post, DoraHacks submission

## Order of work (original)
1. Read the RWA docs and record real responses into `fixtures/` → **day 1**
2. `server/cmc.ts` client (cache, evidence log, mock mode) + API routes → day 1–2
3. Web dashboard (explorer, issuer scorecard, peg monitor, market share chart) → day 2–4
4. MCP server + Claude Desktop config snippet → day 4
5. Telegram alerts (stretch) → day 5
6. README (endpoints list, screenshots, API feedback section), deploy (Render/Fly/Vercel), demo video, X post → final days

## Submission checklist
- [ ] Public GitHub repo (no key committed! `.env` is gitignored)
- [ ] Deployed link + 2–3 min demo video
- [ ] README: endpoints named explicitly, plus a sample request/response from `evidence/`
- [ ] "What the API made possible / where it got in the way" note (`docs/API_FEEDBACK.md`)
- [ ] X post with DoraHacks link, video and #BuildwithCMC → paste URL in form
- [ ] Track selected: Real World Assets
- [ ] Register on DoraHacks with the **CMC account email** to get the Startup tier
