/**
 * Cloudflare Pages entry (advanced mode). Bundled by scripts/build-cloudflare.mjs
 * into dist-cf/_worker.js next to the built web UI.
 *
 * - /api/* is handled by the same Hono app as the Node server.
 * - Everything else is a static asset (env.ASSETS).
 * - State lives in a D1 database bound as DB: one `kv` table holding the same JSON
 *   documents the Node build keeps in data/*.json. Each API request loads all
 *   documents (one query), runs, then writes back only what changed (one batch).
 *   Requests in an isolate are serialized so they never overwrite each other.
 * - No DB binding? It still runs, with state kept in memory per isolate (the UI
 *   shows a warning, because that state is lost whenever the isolate recycles).
 * - Scheduled agent runs piggyback on traffic (the UI polls /api/status every 15s)
 *   via ctx.waitUntil, and POST /api/cron can be hit by an external cron.
 */
import { createApp } from "./app.ts";
import { config, configure, pendingTasks } from "./config.ts";
import { jobDue, tick } from "./scheduler.ts";
import { hydrate, setStoreBackend, takeDirty } from "./store.ts";

// Minimal Cloudflare types (kept local so the Node/DOM type environment stays clean).
interface D1Result<T> { results: T[] }
interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  all<T>(): Promise<D1Result<T>>;
  run(): Promise<unknown>;
}
interface D1Database {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown>;
}
interface Fetcher { fetch(req: Request): Promise<Response> }
interface ExecutionContext { waitUntil(p: Promise<unknown>): void }
interface Env {
  ASSETS: Fetcher;
  DB?: D1Database;
  [key: string]: unknown;
}

setStoreBackend({ kind: "deferred" });
const app = createApp();

// ---------- state load/save ----------
const memory = new Map<string, string>();
let schemaReady = false;

async function load(env: Env) {
  if (!env.DB) {
    hydrate(memory);
    return;
  }
  if (!schemaReady) {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at INTEGER NOT NULL)").run();
    schemaReady = true;
  }
  const { results } = await env.DB.prepare("SELECT k, v FROM kv").all<{ k: string; v: string }>();
  hydrate(new Map(results.map((r) => [r.k, r.v])));
}

async function save(env: Env) {
  const dirty = takeDirty();
  if (!dirty.length) return;
  if (!env.DB) {
    for (const d of dirty) memory.set(d.name, d.text);
    return;
  }
  const db = env.DB;
  await db.batch(
    dirty.map((d) =>
      db
        .prepare("INSERT INTO kv (k, v, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at")
        .bind(d.name, d.text, Date.now()),
    ),
  );
}

// ---------- per-isolate request serialization ----------
let chain: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

function setup(env: Env) {
  const vars: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") vars[k] = v;
  configure(vars, "cloudflare");
  config.persistent = Boolean(env.DB);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    setup(env);
    return exclusive(async () => {
      try {
        await load(env);
      } catch (err) {
        return Response.json({ error: `storage unavailable: ${(err as Error).message}` }, { status: 503 });
      }
      const res = await app.fetch(request);
      let due: string | null = null;
      try {
        due = jobDue();
      } catch {}
      try {
        await save(env);
      } catch (err) {
        console.error("[worker] save failed", err);
      }
      if (due) {
        // run the due job after responding, under the same lock and persistence
        ctx.waitUntil(
          exclusive(async () => {
            await load(env);
            await tick();
            await save(env);
          }).catch((err) => console.error("[worker] scheduled job failed", err)),
        );
      }
      const tasks = pendingTasks.splice(0);
      if (tasks.length) ctx.waitUntil(Promise.all(tasks));
      return res;
    });
  },
};
