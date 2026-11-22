import { z } from "zod";
import { jsonStore } from "./store.ts";

export const SettingsSchema = z.object({
  /** scheduler: run the agent every intervalMin minutes */
  agentEnabled: z.boolean(),
  intervalMin: z.number().int().min(5).max(24 * 60),
  /** true: agent orders fill immediately. false: they wait for approval in the UI */
  autopilot: z.boolean(),
  /** balanced: discounts + momentum + rebounds · momentum: trend-following · value: discounts vs peers + rebounds */
  strategy: z.enum(["balanced", "momentum", "value"]),
  /** minimum 0-100 screener score for a new entry */
  minScore: z.number().min(0).max(100),
  // ---- risk limits, enforced in code on every order ----
  killSwitch: z.boolean(),
  maxPositionPct: z.number().min(1).max(100),
  maxGrossExposurePct: z.number().min(0).max(100),
  minCashPct: z.number().min(0).max(100),
  minTradeUsd: z.number().min(1),
  maxOrdersPerRun: z.number().int().min(0).max(20),
  minVol24h: z.number().min(0),
  maxBuyPremiumPct: z.number().min(0).max(50),
  stopLossPct: z.number().min(0).max(100),
  takeProfitPct: z.number().min(0).max(1000),
  avoidLeveraged: z.boolean(),
  allowedTypes: z.array(z.enum(["stock", "commodity", "currency", "government_security", "etf", "real_estate"])),
  blockedSymbols: z.array(z.string()),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  agentEnabled: false,
  intervalMin: 60,
  autopilot: false,
  strategy: "balanced",
  minScore: 55,
  killSwitch: false,
  maxPositionPct: 20,
  maxGrossExposurePct: 80,
  minCashPct: 10,
  minTradeUsd: 100,
  maxOrdersPerRun: 4,
  minVol24h: 250_000,
  maxBuyPremiumPct: 1.5,
  stopLossPct: 8,
  takeProfitPct: 20,
  avoidLeveraged: true,
  allowedTypes: ["stock", "commodity", "currency", "government_security", "etf", "real_estate"],
  blockedSymbols: [],
};

const store = jsonStore<Settings>("settings.json", () => ({ ...DEFAULT_SETTINGS }));
export const getSettings = () => store.get();
export function updateSettings(patch: Partial<Settings>) {
  const next = SettingsSchema.parse({ ...store.get(), ...patch });
  store.set(next);
  return next;
}
