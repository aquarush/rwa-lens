# Demo script (2-3 minutes)

A walkthrough for the hackathon video. Start the app with live keys, reset the portfolio, and keep the browser at about 1440px wide.

| Time | Screen | Say / do |
|---|---|---|
| 0:00 | Dashboard | "Tokenized stocks, ETFs and gold now come from many issuers at once: NVIDIA alone has seven tokens. RWA Lens uses CoinMarketCap's new real-world-asset endpoints to tell you which one to hold, and lets an AI agent trade them on paper." Point at RWA market cap, RWA share of crypto, the off-peg count. |
| 0:20 | Screener | Search `NVDA`. "Every token is priced against its siblings. Here's the cheapest NVIDIA token right now, and how liquid it is." Filter Signal → *discount*, tick *Liquid only*. |
| 0:40 | Asset detail (click a row) | 90-day chart from `quotes/historical`, the sibling table with *vs peers*. Mention `UNIT_MISMATCH`: "CMC lists some tokens in different units. A naive screener calls them 90% de-pegs; we detect that." |
| 1:00 | Issuers | "Issuer scorecard: market cap, turnover, and peg tightness per issuer." |
| 1:10 | AI Agent | Show the risk settings and the kill switch. Click **Run agent now**. While it runs: "Claude researches with tools (screen, token detail, portfolio) and every order goes through risk limits enforced in code, not in the prompt." |
| 1:40 | AI Agent → journal | Scroll the journal: reasoning summary, tool calls, orders, a risk rejection if there is one. Approve the proposals in the approval queue. |
| 2:00 | Portfolio | Positions, slippage and fees per fill, equity curve. |
| 2:15 | Claude Desktop (MCP) | Ask *"Is any gold token de-pegged right now?"*, which calls `rwa_peg_check`. |
| 2:30 | API Evidence | "Every real CoinMarketCap call is logged with the key redacted, plus caching and a daily credit budget." Close on the endpoints list in the README. |

## Before recording

- [ ] `ANTHROPIC_API_KEY` set, so the agent runs on Claude rather than the rule engine
- [ ] Portfolio reset (Portfolio → Reset)
- [ ] Autopilot **off**, to show the approval flow
- [ ] Claude Desktop configured with the MCP server (see README)

## Submission checklist

- [ ] Public GitHub repo (`.env` is gitignored, so check `git status` before pushing)
- [ ] Deployed link with `ADMIN_TOKEN` set
- [ ] 2-3 minute demo video
- [ ] README names the endpoints and includes a sample request and response
- [ ] `docs/API_FEEDBACK.md`
- [ ] X post with the DoraHacks link, video and #BuildwithCMC; paste the URL in the form
- [ ] Track: Real World Assets
