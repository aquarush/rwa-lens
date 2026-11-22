import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Load .env from the project root regardless of cwd (MCP clients launch us from elsewhere).
// quiet: dotenv's banner goes to stdout, which would corrupt the MCP stdio protocol.
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

export const config = {
  port: Number(process.env.PORT ?? 8787),
  cmcKey: process.env.CMC_API_KEY?.trim() || "",
  cmcBase: process.env.CMC_BASE_URL ?? "https://pro-api.coinmarketcap.com",
  telegramToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  telegramChat: process.env.TELEGRAM_CHAT_ID ?? "",
  dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data"),
  evidenceDir: path.join(ROOT, "evidence"),
  fixturesDir: path.join(ROOT, "fixtures"),
  production: process.env.NODE_ENV === "production",
};

export const mockMode = () => !config.cmcKey;
