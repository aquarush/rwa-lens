# DoraHacks submission kit

Copy-paste material for the *Create a new Build* form.

## Name of your Build

**RWA Lens**

## Brief description (one line)

> Screener, peg monitor and explainable paper-trading agent for tokenized stocks, ETFs and gold, built on CoinMarketCap's RWA API. It prices every issuer's token against its true peers and trades on paper under risk limits enforced in code.

Shorter alternative (if the field is tight):

> Which tokenized NVIDIA should you hold? RWA Lens prices every issuer's token against its peers, flags de-pegs, and runs an explainable paper-trading agent, all on CoinMarketCap data.

## Project overview (long description, Markdown)

```markdown
## RWA Lens: which tokenized asset should you actually hold?

Tokenized stocks, ETFs and gold now come from many issuers at once. NVIDIA alone has **7 live tokens** (xStocks, Ondo, bStocks, Robinhood, Coinbase, Reality, wrapped xStock), and gold has PAXG, XAUt, Matrixdock and more. They don't trade at the same price, they aren't equally liquid, and, as we found in CoinMarketCap's live data, **they aren't even quoted in the same unit**.

RWA Lens turns CoinMarketCap's new `/v5/real-world-assets` API into a screener, a peg monitor and an explainable paper-trading agent.

### What makes it different
- **Peer pricing that survives real data.** CMC's `average_tokenized_price` can be skewed by tokens quoted in other units (two SanDisk tokens at ~$655 against five at ~$82 put the "average" at $87.7, so every real token looked 6% cheap; per-gram gold tokens look like 97% de-pegs). RWA Lens detects the unit, flags outliers as `UNIT_MISMATCH`, and prices each token against the volume-weighted median of its *other* comparable siblings.
- **A trading agent you can audit.** Each run it reads the market regime (global metrics), reviews positions, screens ~263 tokens (with counts of why each was filtered out), researches 30-day history, and sizes orders by volatility. Every hold, skip, buy and sell is explained in a journal, with the numbers behind it. No black box, no external AI service.
- **Risk limits enforced in code, not in a prompt.** Kill switch, position and exposure caps, cash floor, minimum liquidity, max premium paid, leveraged-ETF block, stop-loss and take-profit. Autopilot is off by default: the agent proposes, you approve.
- **Works with AI assistants.** A built-in MCP server lets Claude Desktop, Claude Code or Cursor research RWAs and place paper orders in plain language.
- **Deploys anywhere.** Node, or one zip on Cloudflare Pages (worker + D1, free tier).

### Features
Dashboard (RWA share of crypto, off-peg count, movers) · Screener with signals and a 0-100 score · Asset pages with 90-day/hourly history · Issuer scorecard with *peg tightness* · Agent console with journal, approvals and strategy styles (balanced / momentum / value) · Paper portfolio with fees, slippage and equity curve · Alerts (+Telegram) · API Evidence page logging every live call.

### CoinMarketCap endpoints used
`/v5/real-world-assets/assets/list` · `/quotes/latest` · `/quotes/historical` · `/issuers/list` · `/info` · `/market-pairs/list` · `/v2/cryptocurrency/quotes/latest` · `/v1/global-metrics/quotes/latest` · `/v1/key/info`

Every live call is logged with the key redacted. Responses are cached, and a daily credit budget prevents overspend.

### API feedback
We documented 9 issues we hit with the live API: string vs number `error_code`, mixed units within an asset, null/placeholder rows, duplicate symbols, market pairs returning 403 on our plan, and more. See `docs/API_FEEDBACK.md`.

### Tech
TypeScript · Hono (Node + Cloudflare Workers) · Vite + Chart.js · D1 · MCP SDK · 12 tests + CI · secret guard so API keys can never be committed.

Built from scratch for this hackathon. **Paper trading only, not financial advice.**
```

## Tags

`RWA` · `Crypto / Web3` · `Infra / API` · `DeFi`

## Track

**Real World Assets** is the natural fit but crowded (Parallax, WrapWise and Signal Desk also compare issuer tokens). **Markets and Trading Tools** has fewer entries and fits the screener + agent. Either way, lead with the agent, the risk engine and the data-quality findings.

## Links

| Field | Value |
|---|---|
| GitHub Repo | `https://github.com/<you>/rwa-lens` |
| Video | YouTube / Loom link to the 2-3 min demo (script: `docs/DEMO.md`) |
| Website | `https://<project>.pages.dev` (see `docs/DEPLOY_CLOUDFLARE.md`) |

## Logo / cover image prompts

Use with any image generator. Don't put the CoinMarketCap or DoraHacks logos or names in the image: it's your project's mark, not theirs.

**Logo (square, 1:1):**

> Minimal flat vector logo for a fintech app called "RWA Lens". A circular magnifying-glass lens in bright azure blue (#2a78d6) with a thick rounded rim and a short diagonal handle at the bottom right. Inside the lens, three small simple icons side by side: a gold bar, a rising stock candlestick, and a tiny building, all in muted gold (#d4a017) and slate, overlapping slightly like layers seen through glass. Clean geometric shapes, no gradients or only a very subtle one, generous padding, centred on a solid off-white (#fcfcfb) background. No text, no letters, no watermark. Crisp and legible at 64×64 pixels, modern Swiss design style.

**Dark variant:** the same prompt, ending with *"on a solid near-black (#121211) background, lens rim slightly lighter blue (#3987e5)."*

**Cover / banner (16:9, optional):**

> Wide hero banner for a fintech dashboard called "RWA Lens", dark theme (#121211 background). On the left, a large glowing azure-blue (#3987e5) magnifying-glass lens. Through the lens, several near-identical tokens of the same asset (gold coins and stock-ticker chips) appear side by side at slightly different heights, one highlighted as the cheapest with a soft green glow and one marked rich with a soft red glow. On the right, faint, tasteful UI elements: a thin line chart, a small data table, a toggle labelled "Autopilot off". Flat vector, crisp, lots of negative space, professional and calm, no logos of real companies, no readable small text except the title "RWA Lens" in a clean sans-serif.
