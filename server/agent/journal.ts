import { jsonStore } from "../store.ts";

export type StepType = "info" | "thinking" | "text" | "tool_call" | "tool_result" | "order" | "error";
export interface Step {
  t: string;
  type: StepType;
  title: string;
  detail?: unknown;
}
export interface AgentRun {
  id: string;
  trigger: "manual" | "schedule";
  /** strategy style used for the run (older runs may carry a legacy "engine" field) */
  strategy: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "done" | "error";
  summary?: string;
  steps: Step[];
  orderIds: string[];
  equityBefore?: number;
  equityAfter?: number;
}

const store = jsonStore<{ runs: AgentRun[] }>("agent-runs.json", () => ({ runs: [] }));

export function startRun(trigger: AgentRun["trigger"], strategy: string): AgentRun {
  const run: AgentRun = { id: crypto.randomUUID(), trigger, strategy, startedAt: new Date().toISOString(), status: "running", steps: [], orderIds: [] };
  store.update((s) => {
    s.runs.push(run);
    if (s.runs.length > 40) s.runs.splice(0, s.runs.length - 40);
  });
  return run;
}

export function step(run: AgentRun, type: StepType, title: string, detail?: unknown) {
  run.steps.push({ t: new Date().toISOString(), type, title, detail });
  save(run);
}

export function save(run: AgentRun) {
  store.update((s) => {
    const i = s.runs.findIndex((r) => r.id === run.id);
    if (i >= 0) s.runs[i] = run;
  });
}

export const listRuns = (limit = 30) => store.get().runs.slice(-limit).reverse().map(({ steps, ...r }) => ({ ...r, stepCount: steps.length }));
export const getRun = (id: string) => store.get().runs.find((r) => r.id === id) ?? null;
/** A run left "running" for over 10 minutes was interrupted (restart, platform time limit). */
const STALE_MS = 10 * 60_000;
export const isRunning = () => store.get().runs.some((r) => r.status === "running" && Date.now() - Date.parse(r.startedAt) < STALE_MS);

/** Runs left "running" by a crash/restart are closed on startup. */
export function closeStaleRuns(olderThanMs = 0) {
  const stale = store.get().runs.some((r) => r.status === "running" && Date.now() - Date.parse(r.startedAt) >= olderThanMs);
  if (!stale) return;
  store.update((s) => {
    for (const r of s.runs) if (r.status === "running" && Date.now() - Date.parse(r.startedAt) >= olderThanMs) {
      r.status = "error";
      r.summary = "interrupted (server restarted)";
      r.finishedAt = new Date().toISOString();
    }
  });
}
