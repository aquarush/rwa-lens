#!/usr/bin/env node
/**
 * Build the Cloudflare Pages output:
 *   dist-cf/              static web UI (from web/dist) + _worker.js (the API)
 *   rwa-lens-cloudflare-pages.zip   the same folder, zipped for dashboard drag-and-drop
 *
 *   npm run build:cf
 *
 * The worker is bundled with platform "neutral" so the build fails loudly if any
 * Node built-in (fs, path, crypto...) sneaks into the worker code path.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "dist-cf");
const web = path.join(root, "web", "dist");

if (!fs.existsSync(path.join(web, "index.html"))) {
  console.error("web/dist is missing: run `npm run build` first (build:cf does this for you).");
  process.exit(1);
}

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(web, out, { recursive: true });

const result = await build({
  entryPoints: [path.join(root, "server", "worker.ts")],
  outfile: path.join(out, "_worker.js"),
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  mainFields: ["module", "main"],
  conditions: ["workerd", "worker", "browser", "import", "default"],
  minify: true,
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
});

// Pages serves only routes the worker doesn't handle as assets; keep /api/* in the worker.
fs.writeFileSync(path.join(out, "_routes.json"), JSON.stringify({ version: 1, include: ["/api/*"], exclude: [] }, null, 2) + "\n");

const kb = (fs.statSync(path.join(out, "_worker.js")).size / 1024).toFixed(0);
const files = fs.readdirSync(out, { recursive: true }).filter((f) => fs.statSync(path.join(out, f)).isFile());
console.log(`dist-cf/ ready: ${files.length} files, _worker.js ${kb} KB (${Object.keys(result.metafile.inputs).length} modules bundled)`);

const zip = path.join(root, "rwa-lens-cloudflare-pages.zip");
fs.rmSync(zip, { force: true });
// files must sit at the zip root (index.html, _worker.js), not inside a folder
const attempts = [
  ["zip", ["-q", "-r", "-X", zip, "."]],
  ["python3", ["-c", "import shutil,sys; shutil.make_archive(sys.argv[1][:-4], 'zip', root_dir=sys.argv[2])", zip, out]],
];
let zipped = false;
for (const [cmd, args] of attempts) {
  try {
    execFileSync(cmd, args, { cwd: out, stdio: "ignore" });
    zipped = fs.existsSync(zip);
    if (zipped) break;
  } catch {}
}
if (zipped) console.log(`zip ready: ${path.relative(root, zip)} (${(fs.statSync(zip).size / 1024).toFixed(0)} KB) - drag it into Cloudflare Pages → Upload assets`);
else console.log("No `zip` or `python3` found; upload the dist-cf/ folder instead (drag-and-drop accepts a folder too).");
