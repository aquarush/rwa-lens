/**
 * Runtime configuration, platform-neutral. Node fills it from process.env/.env
 * (server/node/bootstrap.ts); the Cloudflare worker fills it from its env
 * bindings (server/worker.ts). Nothing here imports Node built-ins.
 */
export const config = {
  port: 8787,
  cmcKey: "",
  cmcBase: "https://pro-api.coinmarketcap.com",
  adminToken: "",
  dailyCreditBudget: 600,
  paperStartingCash: 100_000,
  mtmIntervalMin: 10,
  depegAlertPct: 1.5,
  telegramToken: "",
  telegramChat: "",
  /** "node" or "cloudflare" - a few behaviours differ (scheduler, run concurrency) */
  platform: "node" as "node" | "cloudflare",
  /** true when state persists (files on Node, D1 on Cloudflare) */
  persistent: true,
};

type Vars = Record<string, string | undefined>;
const num = (v: string | undefined, d: number) => (v != null && v !== "" && isFinite(Number(v)) ? Number(v) : d);

export function configure(vars: Vars, platform: "node" | "cloudflare") {
  config.platform = platform;
  config.port = num(vars.PORT, config.port);
  config.cmcKey = vars.CMC_API_KEY?.trim() || "";
  config.cmcBase = vars.CMC_BASE_URL || config.cmcBase;
  config.adminToken = vars.ADMIN_TOKEN?.trim() || "";
  config.dailyCreditBudget = num(vars.CMC_DAILY_CREDIT_BUDGET, config.dailyCreditBudget);
  config.paperStartingCash = num(vars.PAPER_STARTING_CASH, config.paperStartingCash);
  config.mtmIntervalMin = num(vars.MTM_INTERVAL_MIN, config.mtmIntervalMin);
  config.depegAlertPct = num(vars.DEPEG_ALERT_PCT, config.depegAlertPct);
  config.telegramToken = vars.TELEGRAM_BOT_TOKEN?.trim() || "";
  config.telegramChat = vars.TELEGRAM_CHAT_ID?.trim() || "";
}

export const mockMode = () => !config.cmcKey;

/** Optional platform hooks (Node sets these; the worker leaves them empty). */
export const hooks: {
  /** append a live CMC call to a durable evidence file */
  evidence?: (line: Record<string, unknown>) => void;
  /** recorded fixture for a request key, if one exists */
  fixture?: (key: string) => unknown | null;
  /** save a live response as a fixture (npm run record) */
  record?: (key: string, body: unknown) => void;
} = {};

/**
 * Fire-and-forget work (e.g. Telegram messages). Node just lets it run; the
 * Cloudflare worker hands the queue to ctx.waitUntil() so it isn't cancelled.
 */
export const pendingTasks: Promise<unknown>[] = [];
export function background(p: Promise<unknown>) {
  const safe = p.catch(() => {});
  if (config.platform === "cloudflare") pendingTasks.push(safe);
}
