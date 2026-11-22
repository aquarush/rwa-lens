# DoraHacks submission kit

Copy-paste material for the *Create a new Build* form.

## Name of your Build

**RWA Lens**

## Brief description (one line)

> Screener, peg monitor and explainable paper-trading agent for tokenized stocks, ETFs and gold, built on CoinMarketCap's RWA API. It prices every issuer's token against its true peers and trades on paper under risk limits enforced in code.

Shorter alternative (if the field is tight):

> Which tokenized NVIDIA should you hold? RWA Lens prices every issuer's token against its peers, flags de-pegs, and runs an explainable paper-trading agent, all on CoinMarketCap data.

## Project overview (long description, Markdown)

Paste everything inside the block into the DoraHacks project description. All links are absolute so they work there. Replace the video link once it's uploaded.

```markdown
# RWA Lens

**Which tokenized NVIDIA, gold or S&P 500 token should you actually hold?**
RWA Lens is a screener, peg monitor and explainable paper-trading agent for tokenized real-world assets, built on CoinMarketCap's new RWA API.

🔗 **Live demo:** https://rwalens.pages.dev
💻 **Source code:** https://github.com/aquarush/rwa-lens
🎥 **Demo video:** <YOUTUBE_OR_LOOM_LINK>
📖 **5-minute walkthrough:** https://github.com/aquarush/rwa-lens#demo-walkthrough-5-minutes

---

## The problem
Tokenized stocks, ETFs and gold now come from many issuers at once. NVIDIA alone has **7 live tokens** (xStocks, Ondo, bStocks, Robinhood, Coinbase, Reality, wrapped xStock). They trade at different prices, have very different liquidity, and, as we found in CoinMarketCap's live data, **aren't even quoted in the same unit**: some gold tokens are priced per gram and others per ounce, and two SanDisk tokens trade at ~$655 against ~$82 for the rest. A naive comparison calls these 90%+ de-pegs, and CMC's own `average_tokenized_price` gets skewed by them.

## What RWA Lens does
- **Prices every token against its true peers.** It detects each asset's dominant unit, flags outliers as `UNIT_MISMATCH`, and compares each token with the volume-weighted median of its *other* comparable siblings. Result: a clean "vs peers" premium or discount for ~263 tokens across ~60 assets.
- **Screener and signals.** DISCOUNT, PREMIUM, MOMENTUM_UP/DOWN, REBOUND, ILLIQUID, UNIT_MISMATCH, LEVERAGED, plus a 0-100 score blending liquidity, momentum, value vs peers and size.
- **An explainable trading agent (paper only).** Each run it reads the market regime from global metrics, reviews open positions, screens the universe (with counts of why each token was filtered out), researches 30-day history, and sizes orders by volatility. Every hold, skip, buy and sell is journaled with the numbers behind it. It uses CoinMarketCap data only, with no external AI service.
- **Risk limits enforced in code.** Kill switch, position and exposure caps, cash floor, minimum liquidity, max premium paid, leveraged-ETF block, stop-loss and take-profit. **Autopilot is off by default**: the agent proposes, you approve.
- **Issuer scorecard.** Market cap, turnover and *peg tightness* per issuer (Backed/xStocks, Ondo, bStocks, Paxos, Tether, Robinhood…).
- **Alerts** for de-pegs, fills, risk exits and agent runs, optionally to Telegram.
- **AI-assistant ready (MCP).** A built-in MCP server lets Claude Desktop, Claude Code or Cursor research RWAs and place paper orders in plain language: *"Is any gold token de-pegged?"*
- **API Evidence page.** Every live CoinMarketCap call is logged (key redacted) with credits and timing. Caching and a daily credit budget prevent overspend.

## CoinMarketCap API usage
| Endpoint | Used for |
|---|---|
| `/v5/real-world-assets/assets/list` | RWA universe ranked by tokenized market cap |
| `/v5/real-world-assets/quotes/latest` | Every token tracking each asset (issuer, price, cap, volume) |
| `/v5/real-world-assets/quotes/historical` | Charts; 30-day return, volatility and drawdown for the agent |
| `/v5/real-world-assets/issuers/list` · `/info` | Issuer directory · asset metadata |
| `/v5/real-world-assets/market-pairs/list` | Exchange pairs (handled gracefully where the plan returns 403) |
| `/v2/cryptocurrency/quotes/latest` | Token-level momentum; cheap position re-pricing |
| `/v1/global-metrics/quotes/latest` | RWA share of crypto; the agent's market regime |
| `/v1/key/info` | Credit usage |

Sample of real calls (key redacted): https://github.com/aquarush/rwa-lens/blob/main/docs/evidence-sample.jsonl

## Feedback on the API
We documented 9 concrete issues from building against the live API: string vs number `error_code`, mixed units within one asset, null and placeholder rows, duplicate symbols, plan-restricted market pairs, and more, with suggested fixes.
👉 https://github.com/aquarush/rwa-lens/blob/main/docs/API_FEEDBACK.md

## Tech
TypeScript · Hono (one API on Node **and** Cloudflare Workers) · Vite + Chart.js · Cloudflare Pages + D1 · MCP SDK · 12 automated tests + CI · a secret guard that blocks API keys from ever being committed.

## Docs
- README & setup: https://github.com/aquarush/rwa-lens#readme
- Architecture: https://github.com/aquarush/rwa-lens/blob/main/docs/ARCHITECTURE.md
- Deploy to Cloudflare Pages (one zip): https://github.com/aquarush/rwa-lens/blob/main/docs/DEPLOY_CLOUDFLARE.md
- Connect an AI agent (MCP): https://github.com/aquarush/rwa-lens#connect-ai-agents-mcp

## Try it in 60 seconds
1. Open https://rwalens.pages.dev
2. **Screener** → search `NVDA` → see which issuer's token is cheapest vs its peers
3. **Agent** → *Run agent now* → read the journal → approve a proposal
4. **Portfolio** → see the paper fill with fees and slippage

---
Built from scratch for **Build with CMC: API Hackathon Round 2** (#BuildwithCMC). **Paper trading only. Not financial advice.**
```

## Tags

`RWA` · `Crypto / Web3` · `Infra / API` · `DeFi`

## Track

**Real World Assets** is the natural fit but crowded (Parallax, WrapWise and Signal Desk also compare issuer tokens). **Markets and Trading Tools** has fewer entries and fits the screener + agent. Either way, lead with the agent, the risk engine and the data-quality findings.

## Links

| Field | Value |
|---|---|
| GitHub Repo | https://github.com/aquarush/rwa-lens |
| Video | YouTube / Loom link to the 2-3 min demo (script: `docs/DEMO.md`) |
| Website | https://rwalens.pages.dev |

## Logo / cover image prompts

Use with any image generator. Don't put the CoinMarketCap or DoraHacks logos or names in the image: it's your project's mark, not theirs.

**Logo (square, 1:1):**

> Minimal flat vector logo for a fintech app called "RWA Lens". A circular magnifying-glass lens in bright azure blue (#2a78d6) with a thick rounded rim and a short diagonal handle at the bottom right. Inside the lens, three small simple icons side by side: a gold bar, a rising stock candlestick, and a tiny building, all in muted gold (#d4a017) and slate, overlapping slightly like layers seen through glass. Clean geometric shapes, no gradients or only a very subtle one, generous padding, centred on a solid off-white (#fcfcfb) background. No text, no letters, no watermark. Crisp and legible at 64×64 pixels, modern Swiss design style.

**Dark variant:** the same prompt, ending with *"on a solid near-black (#121211) background, lens rim slightly lighter blue (#3987e5)."*

**Cover / banner (16:9, optional):**

> Wide hero banner for a fintech dashboard called "RWA Lens", dark theme (#121211 background). On the left, a large glowing azure-blue (#3987e5) magnifying-glass lens. Through the lens, several near-identical tokens of the same asset (gold coins and stock-ticker chips) appear side by side at slightly different heights, one highlighted as the cheapest with a soft green glow and one marked rich with a soft red glow. On the right, faint, tasteful UI elements: a thin line chart, a small data table, a toggle labelled "Autopilot off". Flat vector, crisp, lots of negative space, professional and calm, no logos of real companies, no readable small text except the title "RWA Lens" in a clean sans-serif.
