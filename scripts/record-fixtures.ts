/**
 * Record real CMC responses into fixtures/recorded/ so mock mode (no API key)
 * replays a real market snapshot instead of synthetic data.
 *
 *   npm run record            # top 10 assets (~60-70 credits)
 *   npm run record -- 20      # top 20 assets
 *
 * Requires CMC_API_KEY. Requests not recorded fall back to the synthetic generator.
 */
export {};
process.env.CMC_RECORD = "1";
const { config } = await import("../server/config.ts");
if (!config.cmcKey) {
  console.error("CMC_API_KEY is not set; nothing to record.");
  process.exit(1);
}
const { snapshot, marketOverview } = await import("../server/screener.ts");
const { assetHistory, assetInfo, issuers, marketPairs } = await import("../server/rwa.ts");
const { cmcStats } = await import("../server/cmc.ts");

const n = Number(process.argv[2] ?? 10);
const snap = await snapshot();
await marketOverview();
await issuers();
const topAssets = [...snap.assets].sort((a, b) => b.mcap - a.mcap).slice(0, n);
for (const a of topAssets) {
  // the exact requests the asset page and the agent's token-detail tool make
  await Promise.all([assetInfo(a.rwaId), assetHistory(a.rwaId, "daily", 90), assetHistory(a.rwaId, "daily", 30), assetHistory(a.rwaId, "hourly", 168), marketPairs(a.rwaId)]);
  console.log(`recorded ${a.symbol}`);
}
const s = cmcStats();
console.log(`done: ${s.live} live calls, ${s.credits} credits -> fixtures/recorded/`);
