#!/usr/bin/env node
/**
 * Secret guard. Blocks commits (pre-commit hook) and CI builds that would
 * publish an API key.
 *
 *   node scripts/check-secrets.mjs --staged   # scan what is about to be committed
 *   node scripts/check-secrets.mjs            # scan every tracked file (CI)
 *
 * Fails on:
 *  - any .env file other than .env.example being tracked or staged
 *  - the literal value of any *_KEY / *_TOKEN / *_SECRET from your local .env
 *  - well-known key shapes (Anthropic keys, a CMC key assigned to the header or
 *    env var, Telegram bot tokens, private key blocks)
 * No dependencies; works with plain Node.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const staged = process.argv.includes("--staged");
const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const files = (staged ? git("diff", "--cached", "--name-only", "--diff-filter=ACMR") : git("ls-files"))
  .split("\n")
  .filter(Boolean);

// Values from the developer's own .env: these must never appear in a tracked file.
const localSecrets = [];
if (fs.existsSync(".env")) {
  for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*=\s*["']?([^"'#\s]+)/);
    if (m && m[3].length >= 8) localSecrets.push({ name: m[1], value: m[3] });
  }
}

const PATTERNS = [
  { name: "Anthropic API key", re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "CMC API key in header/env", re: /(CMC_PRO_API_KEY|CMC_API_KEY)["']?\s*[:=]\s*["']?[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}/ },
  { name: "Telegram bot token", re: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/ },
  { name: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

const SKIP = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|pdf)$|^package-lock\.json$/;
const problems = [];

for (const f of files) {
  if (/(^|\/)\.env($|\.)/.test(f) && !f.endsWith(".env.example")) {
    problems.push(`${f}: .env files must never be committed`);
    continue;
  }
  if (SKIP.test(f)) continue;
  let text;
  try {
    text = staged ? git("show", `:${f}`) : fs.readFileSync(f, "utf8");
  } catch {
    continue; // deleted or unreadable
  }
  for (const s of localSecrets) if (text.includes(s.value)) problems.push(`${f}: contains the value of ${s.name} from your .env`);
  for (const p of PATTERNS) if (p.re.test(text)) problems.push(`${f}: looks like an exposed ${p.name}`);
}

if (problems.length) {
  console.error("\n✖ Secret guard blocked this " + (staged ? "commit" : "build") + ":\n");
  for (const p of problems) console.error("  - " + p);
  console.error("\nRemove the secret (keys belong in .env, which is gitignored) and try again.\n");
  process.exit(1);
}
console.log(`✓ secret guard: ${files.length} ${staged ? "staged" : "tracked"} file(s) clean`);
