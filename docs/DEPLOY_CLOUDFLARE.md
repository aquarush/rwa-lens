# Deploying to Cloudflare Pages

RWA Lens deploys to Cloudflare Pages as static files plus one **advanced-mode `_worker.js`**, which serves the API. State lives in a **D1** database. Everything fits in Cloudflare's free tier.

```
rwa-lens-cloudflare-pages.zip
├── index.html, assets/   the web UI
├── _worker.js            the API (same code as the Node server, bundled, no Node built-ins)
└── _routes.json          only /api/* invokes the worker; everything else is served as static files
```

## 1. Build the zip

```bash
npm install
npm run build:cf          # → dist-cf/ and rwa-lens-cloudflare-pages.zip
```

## 2. Deploy with the dashboard (drag and drop)

1. **Create the database.** *Workers & Pages → D1 SQL Database → Create* and name it `rwa-lens`. You don't need to create any tables; the app creates its single `kv` table on first use.
2. **Create the project.** *Workers & Pages → Create → Pages → Upload assets*. Name it (e.g. `rwa-lens`), drag in `rwa-lens-cloudflare-pages.zip`, and click **Deploy**.
3. **Add secrets.** In the project, go to *Settings → Variables and Secrets → Add* and add these as **Encrypt** (secret):
   | Name | Value |
   |---|---|
   | `CMC_API_KEY` | your CoinMarketCap key. Leave it unset to run on mock data |
   | `ADMIN_TOKEN` | any long random string. **Required on a public URL**, otherwise visitors can trade, run the agent and spend your credits |

   Optional plain variables: `CMC_DAILY_CREDIT_BUDGET` (default 600; **set it to about 300 once the hackathon closes**, because keys revert to the free Basic tier at roughly 10k credits a month), `PAPER_STARTING_CASH`, `MTM_INTERVAL_MIN`, `DEPEG_ALERT_PCT`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
4. **Bind the database.** Go to *Settings → Bindings → Add → D1 database*, set the variable name to **`DB`**, and select `rwa-lens`.
5. **Redeploy.** Bindings and secrets only apply to deployments made after they're set. Go to *Deployments → Create deployment* and upload the same zip again.
6. Open `https://<project>.pages.dev`. On the **Agent** page, paste your `ADMIN_TOKEN` once; it's saved in your browser and sent with every action.

If you skip step 4, the app still runs, but it shows a warning and keeps state in memory, which resets.

## 2b. Or deploy with Wrangler (CLI)

```bash
npx wrangler login
npx wrangler d1 create rwa-lens
npx wrangler pages project create rwa-lens --production-branch main
npm run build:cf && npm run cf:deploy          # wrangler pages deploy dist-cf
npx wrangler pages secret put CMC_API_KEY --project-name rwa-lens
npx wrangler pages secret put ADMIN_TOKEN --project-name rwa-lens
```

Then add the D1 binding `DB` in the dashboard (step 4 above) and run `npm run cf:deploy` again.

## 3. Test locally in the Cloudflare runtime

```bash
echo "CMC_API_KEY=your-key" > .dev.vars   # gitignored; leave it out for mock data
npm run build:cf
npm run cf:dev                            # http://localhost:8788, local D1 database
```

## How it behaves on Cloudflare

- **Persistence.** Each API request loads the app's JSON documents from D1 in one query and writes back only the ones that changed, in one batch. Requests in a worker instance are serialized so they can't overwrite each other.
- **Scheduled agent runs.** Workers have no background timers. Scheduled runs and position re-pricing fire right after any API request, and the open UI polls every 15 seconds. To run with nobody watching, point an external cron at the endpoint every few minutes:
  ```bash
  curl -X POST https://<project>.pages.dev/api/cron -H "x-admin-token: <ADMIN_TOKEN>"
  ```
  Options include [cron-job.org](https://cron-job.org), a GitHub Actions schedule, or a tiny Cloudflare Worker with a Cron Trigger.
- **Agent runs** complete within the request (about 2 seconds) before the response is sent.
- **CPU limits.** The free Workers plan allows 10 ms of CPU per request (time spent waiting on CoinMarketCap doesn't count). The app keeps stored documents small: the last 40 agent runs, 500 orders and 60 evidence entries. If you see "exceeded CPU" errors under heavy use, the Workers Paid plan raises the limit.
- **Evidence.** On Cloudflare, the API Evidence page shows the last 60 live calls stored in D1 (with the key redacted). The full JSONL log at `evidence/cmc-calls.jsonl` is a Node-only feature.
