import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";

/** Tiny JSON-file store with atomic writes. Good enough for a single-process app. */
export function jsonStore<T>(name: string, initial: () => T) {
  const file = path.join(config.dataDir, name);
  let state: T;
  try {
    state = { ...initial(), ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    state = initial();
  }
  return {
    get: () => state,
    set(next: T) {
      state = next;
      fs.mkdirSync(config.dataDir, { recursive: true });
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
      fs.renameSync(tmp, file);
    },
    update(fn: (s: T) => void) {
      fn(state);
      this.set(state);
    },
  };
}
