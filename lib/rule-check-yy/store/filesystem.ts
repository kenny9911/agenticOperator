/**
 * Filesystem RunStore — zero-infra audit persistence.
 *
 * Layout:
 *   data/rule-check-runs/
 *   ├── <YYYYMMDD>/<runId>.json          (one per per-rule run)
 *   ├── batches/<batchId>.json           (one per checkRules call)
 *   └── index.jsonl                      (append-only, one line per run)
 *
 * The JSONL index is the cheap query layer — `listRuns` streams the file
 * and filters in-memory. Each entry is self-contained (no joins) so
 * appends are atomic (POSIX O_APPEND single-write semantics).
 *
 * When we outgrow filesystem (likely at ~10k runs), swap to `OpenSearchRunStore`
 * or `ClickHouseRunStore` (see `./external.ts`) — the interface is preserved.
 */

import { readdir, readFile, mkdir, appendFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";

import type {
  RuleCheckBatchRunAudited,
  RuleCheckRunAudited,
} from "../types-audited";

import type { RunIndexEntry, RunQuery, RunStore } from "./index";

const ROOT_DIR = resolve(process.cwd(), "data", "rule-check-runs");
const BATCH_DIR = join(ROOT_DIR, "batches");
const INDEX_PATH = join(ROOT_DIR, "index.jsonl");

export const filesystemRunStore: RunStore = {
  name: "filesystem",

  async writeRun(run: RuleCheckRunAudited): Promise<string> {
    const dateDir = dateStamp(run.timestamp);
    const dir = join(ROOT_DIR, dateDir);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `${run.runId}.json`);
    await writeFile(filePath, JSON.stringify(run, null, 2), "utf-8");
    await appendIndexEntry({
      runId: run.runId,
      batchId: run.batchId,
      timestamp: run.timestamp,
      date: dateDir,
      client: run.input.scope.client,
      actionRef: run.input.actionRef,
      ruleId: run.input.ruleId,
      candidateId: run.input.candidateId,
      decision: run.finalDecision.decision,
      path: filePath,
    });
    return filePath;
  },

  async writeBatch(batch: RuleCheckBatchRunAudited): Promise<string> {
    await mkdir(BATCH_DIR, { recursive: true });
    const filePath = join(BATCH_DIR, `${batch.batchId}.json`);
    await writeFile(filePath, JSON.stringify(batch, null, 2), "utf-8");
    // Per-run entries are appended by writeRun() — caller is responsible for
    // invoking writeRun() per result before writeBatch().
    return filePath;
  },

  async listRuns(query: RunQuery): Promise<RunIndexEntry[]> {
    if (!existsSync(INDEX_PATH)) return [];
    const out: RunIndexEntry[] = [];
    const stream = createReadStream(INDEX_PATH, { encoding: "utf-8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      let entry: RunIndexEntry;
      try {
        entry = JSON.parse(line) as RunIndexEntry;
      } catch {
        continue;
      }
      if (!matchesQuery(entry, query)) continue;
      out.push(entry);
    }
    const offset = query.offset ?? 0;
    const limit = query.limit ?? Number.POSITIVE_INFINITY;
    return out.slice(offset, offset + limit);
  },

  async getRun(runId: string): Promise<RuleCheckRunAudited | null> {
    if (!existsSync(INDEX_PATH)) return null;
    // Linear scan of index to locate path.
    const stream = createReadStream(INDEX_PATH, { encoding: "utf-8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let path: string | null = null;
    for await (const line of rl) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as RunIndexEntry;
        if (entry.runId === runId) {
          path = entry.path;
          break;
        }
      } catch {
        continue;
      }
    }
    if (!path) {
      // Fallback: scan date dirs directly.
      path = await findRunFileByScan(runId);
    }
    if (!path) return null;
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as RuleCheckRunAudited;
  },

  async getBatch(batchId: string): Promise<RuleCheckBatchRunAudited | null> {
    const filePath = join(BATCH_DIR, `${batchId}.json`);
    if (!existsSync(filePath)) return null;
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as RuleCheckBatchRunAudited;
  },
};

// ─── helpers ───

async function appendIndexEntry(entry: RunIndexEntry): Promise<void> {
  await mkdir(ROOT_DIR, { recursive: true });
  await appendFile(INDEX_PATH, `${JSON.stringify(entry)}\n`, "utf-8");
}

function matchesQuery(entry: RunIndexEntry, q: RunQuery): boolean {
  if (q.decision && entry.decision !== q.decision) return false;
  if (q.client && entry.client !== q.client) return false;
  if (q.ruleId && entry.ruleId !== q.ruleId) return false;
  if (q.candidateId && entry.candidateId !== q.candidateId) return false;
  if (q.actionRef && entry.actionRef !== q.actionRef) return false;
  if (q.fromDate && compareDates(entry.date, normalizeDate(q.fromDate)) < 0) return false;
  if (q.toDate && compareDates(entry.date, normalizeDate(q.toDate)) > 0) return false;
  return true;
}

function normalizeDate(input: string): string {
  // Accept "YYYYMMDD" or ISO-8601.
  if (/^\d{8}$/.test(input)) return input;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return input;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function compareDates(a: string, b: string): number {
  return a.localeCompare(b);
}

function dateStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown-date";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

async function findRunFileByScan(runId: string): Promise<string | null> {
  if (!existsSync(ROOT_DIR)) return null;
  const dirs = await readdir(ROOT_DIR);
  for (const sub of dirs) {
    if (!/^\d{8}$/.test(sub)) continue;
    const candidate = join(ROOT_DIR, sub, `${runId}.json`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
