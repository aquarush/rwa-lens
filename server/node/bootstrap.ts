/**
 * Node-only setup. Import this FIRST from every Node entry point (server,
 * MCP server, scripts, tests): it loads .env, fills the config, and plugs in
 * the file-based store, evidence log and fixture hooks. The Cloudflare worker
 * never imports this file, so no Node built-ins reach the worker bundle.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { config, configure, hooks } from "../config.ts";
import { setStoreBackend } from "../store.ts";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// Load .env from the project root regardless of cwd (MCP clients launch us from elsewhere).
// quiet: dotenv's banner goes to stdout, which would corrupt the MCP stdio protocol.
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });
configure(process.env, "node");

export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const EVIDENCE_FILE = path.join(ROOT, "evidence", "cmc-calls.jsonl");
const FIXTURES_DIR = path.join(ROOT, "fixtures", "recorded");
const fixtureFile = (key: string) => path.join(FIXTURES_DIR, crypto.createHash("sha1").update(key).digest("hex") + ".json");

setStoreBackend({
  kind: "sync",
  read(name) {
    try {
      return fs.readFileSync(path.join(DATA_DIR, name), "utf8");
    } catch {
      return null;
    }
  },
  write(name, text) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const file = path.join(DATA_DIR, name);
    fs.writeFileSync(file + ".tmp", text);
    fs.renameSync(file + ".tmp", file);
  },
});

hooks.evidence = (line) => {
  try {
    fs.mkdirSync(path.dirname(EVIDENCE_FILE), { recursive: true });
    fs.appendFileSync(EVIDENCE_FILE, JSON.stringify(line) + "\n");
  } catch (err) {
    console.warn("[cmc] could not write evidence:", (err as Error).message);
  }
};

hooks.fixture = (key) => {
  try {
    return JSON.parse(fs.readFileSync(fixtureFile(key), "utf8"));
  } catch {
    return null;
  }
};

if (process.env.CMC_RECORD === "1") {
  hooks.record = (key, body) => {
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });
    fs.writeFileSync(fixtureFile(key), JSON.stringify(body));
  };
}

export { config };
