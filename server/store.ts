/**
 * Small JSON document store with a synchronous in-memory API and a pluggable
 * backend:
 *  - Node: JSON files in DATA_DIR, loaded lazily and written on every change.
 *  - Cloudflare: one D1 table. The worker hydrates every document before a
 *    request (one query) and flushes the changed ones after it (one batch).
 * Business logic only ever sees get/set/update, so it is identical on both.
 */
export interface SyncBackend {
  kind: "sync";
  read(name: string): string | null;
  write(name: string, text: string): void;
}
export interface DeferredBackend {
  kind: "deferred";
}

let backend: SyncBackend | DeferredBackend | null = null;
export const setStoreBackend = (b: SyncBackend | DeferredBackend) => (backend = b);

interface Doc {
  name: string;
  initial: () => unknown;
  state: unknown;
  loaded: boolean;
  dirty: boolean;
}
const docs = new Map<string, Doc>();

function load(d: Doc) {
  if (d.loaded) return;
  d.loaded = true;
  if (backend?.kind === "sync") {
    const text = backend.read(d.name);
    d.state = merge(d.initial(), text);
  }
}

function merge(initial: unknown, text: string | null) {
  if (!text) return initial;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { ...(initial as object), ...parsed } : initial;
  } catch {
    return initial;
  }
}

export function jsonStore<T>(name: string, initial: () => T) {
  const d: Doc = docs.get(name) ?? { name, initial, state: initial(), loaded: false, dirty: false };
  docs.set(name, d);
  return {
    get: (): T => {
      load(d);
      return d.state as T;
    },
    set(next: T) {
      load(d);
      d.state = next;
      d.dirty = true;
      if (backend?.kind === "sync") {
        backend.write(name, JSON.stringify(next));
        d.dirty = false;
      }
    },
    update(fn: (s: T) => void) {
      const s = this.get();
      fn(s);
      this.set(s);
    },
  };
}

// ---------- deferred (Cloudflare) helpers ----------

/** Replace every document's state with the given serialized values (missing = initial). */
export function hydrate(values: Map<string, string>) {
  for (const d of docs.values()) {
    d.state = merge(d.initial(), values.get(d.name) ?? null);
    d.loaded = true;
    d.dirty = false;
  }
}

/** Documents changed since hydrate(), serialized, and marked clean. */
export function takeDirty(): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  for (const d of docs.values()) {
    if (!d.dirty) continue;
    out.push({ name: d.name, text: JSON.stringify(d.state) });
    d.dirty = false;
  }
  return out;
}
