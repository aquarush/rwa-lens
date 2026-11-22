#!/usr/bin/env node
/**
 * Smoke-test the MCP server the way an AI client would: start it over stdio,
 * do the MCP handshake, list the tools, and call one.
 *
 *   npm run mcp:check
 *
 * No AI client or extra package needed. Uses live data with CMC_API_KEY set,
 * mock data otherwise.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsx = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const server = spawn(tsx, [path.join(root, "mcp", "server.ts")], { stdio: ["pipe", "pipe", "inherit"], shell: process.platform === "win32" });

let buf = "";
const waiting = new Map();
server.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error("✖ non-JSON output on stdout (would break MCP clients):", line);
      process.exitCode = 1;
      continue;
    }
    waiting.get(msg.id)?.(msg);
  }
});

let id = 0;
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const n = ++id;
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 60_000);
    waiting.set(n, (m) => (clearTimeout(timer), resolve(m)));
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
  });

try {
  const init = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "rwa-lens-mcp-check", version: "1" } });
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  console.log(`✓ handshake: ${init.result.serverInfo.name} ${init.result.serverInfo.version}`);

  const tools = await call("tools/list", {});
  console.log(`✓ ${tools.result.tools.length} tools: ${tools.result.tools.map((t) => t.name).join(", ")}`);

  const res = await call("tools/call", { name: "rwa_peg_check", arguments: { query: "gold", min_abs_pct: 0 } });
  const data = JSON.parse(res.result.content[0].text);
  console.log(`✓ rwa_peg_check("gold") returned ${data.count} tokens, e.g. ${data.tokens.slice(0, 3).map((t) => `${t.symbol} ${t.premium_pct > 0 ? "+" : ""}${t.premium_pct}%`).join(", ")}`);

  const pf = await call("tools/call", { name: "portfolio_get", arguments: {} });
  console.log(pf.result.isError ? `• portfolio_get: app not running (start it with npm start to enable portfolio tools)` : "✓ portfolio_get: connected to the running app");
  console.log("\nMCP server works. Add it to your AI client (see README → Connect AI agents).");
} catch (err) {
  console.error("✖", err.message);
  process.exitCode = 1;
} finally {
  server.kill();
}
