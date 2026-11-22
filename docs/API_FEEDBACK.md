# CoinMarketCap API: what it made possible, and where it got in the way

Notes from building RWA Lens against the live API in November 2026.

## What the API made possible

- **`/v5/real-world-assets/quotes/latest` is the key endpoint.** One call returns each asset *and every token that tracks it*, with issuer, price, market cap and volume. That made the whole "which issuer's token is cheapest?" idea possible without stitching together dozens of calls.
- **RWA and classic endpoints share `crypto_id`.** RWA tokens can be enriched with `/v2/cryptocurrency/quotes/latest` for 1h/24h/7d/30d momentum, and held positions can be re-priced for 1 credit per 100 tokens.
- **Issuer IDs** (`issuer_id` on tokens plus `/issuers/list`) made the issuer scorecard a simple aggregation.
- **`/quotes/historical` for RWA** gave asset-level price, cap and volume history back to 2020 at daily resolution on the Startup plan.
- **Credit costs are predictable** (per 250 assets, per 100 data points), and `status.credit_count` on every response made the daily credit budget easy to build.

## Where it got in the way

1. **`error_code` type differs between API generations.** The v5 RWA endpoints return `"error_code": "0"` (a string) and `"error_message": ""`, while v1/v2 return `0` (a number) and `null`. A strict `error_code !== 0` check treats every successful RWA response as an error.
2. **Units are not normalized within an asset.** Under Gold, PAXG and XAUt are priced per troy ounce (~$3,548) but Comtech Gold (CGO) and VNX Gold are ~$113-115, presumably per gram. Two SanDisk tokens trade at ~$655 against ~$82 for the rest. There's no unit or ratio field, so consumers have to infer it.
3. **`average_tokenized_price` is skewed by those unit differences.** For SanDisk it was $87.7 when every same-unit token traded at ~$82.5. We replaced it with a per-token, volume-weighted median of comparable siblings. A server-side "unit-normalized reference price" or a per-token `units_per_underlying` field would help every consumer.
4. **Placeholder rows in live data.** `assets/list` returned a row with `rwa_id: null`. `quotes/latest` token arrays include entries with `symbol: null, price: null`, and "Derivatives" reference rows (`issuer_name: "NA (Derivatives)"`, market cap 0, volume 0) that aren't tradable tokens. A filter flag or a `token_type` field would avoid client-side heuristics.
5. **Token symbols are not unique within an asset.** NVIDIA has tokens from three issuers all with symbol `NVDA`. That's fine once you key everything by `crypto_id`, but it's easy to get wrong.
6. **`asset_type=government_security` returned nothing** for us, although tokenized treasury funds exist on CMC as regular cryptocurrencies. It's unclear whether they will be mapped into the RWA endpoints.
7. **Market pairs are not available on our key's plan (15k credits/month).** `GET /v5/real-world-assets/market-pairs/list` returns HTTP 403 with `error_code: "1006"` ("Your API Key subscription plan doesn't support this endpoint"), although the docs list all six plans for it. RWA Lens remembers the first 1006 and stops asking; the asset page and the agent's tool output say why pairs are missing. Mock mode still demonstrates the feature.
8. **Docs vs. reality.** The RWA ID Map page says it costs no credits, but its example response shows `credit_count: 1`. The full `interval` enum for RWA historical quotes is hidden behind "show 18 more". Response field types are shown only through examples.
9. **No leveraged/inverse flag.** 3x products like SOXL and KORU sit in `etf` alongside SPY. We added a ticker/name heuristic to keep the agent out of them by default; a flag would be better.

## Wishlist

- A `units_per_underlying` (or `reference_price`) field per token.
- `token_type` (spot / wrapped / derivative-reference) and `is_leveraged` fields.
- Websocket or SSE for RWA quotes, so peg monitoring doesn't depend on polling.
