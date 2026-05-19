/**
 * Filesystem RunStore — simple-rule-check audit persistence.
 *
 * Writes one JSON file per run to:
 *   data/simple-rule-check-runs/<YYYYMMDD>/<runId>.json
 *
 * Directory tree is created on demand. Files are pretty-printed for easy
 * eyeballing. Path is gitignored.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { RunStore } from "./index";
import type { RuleCheckRun } from "../types";

const ROOT_DIR = resolve(process.cwd(), "data", "simple-rule-check-runs");

export const filesystemRunStore: RunStore = {
  name: "filesystem",
  async write(run: RuleCheckRun): Promise<string> {
    const dateDir = dateStamp(run.timestamp);
    const dir = join(ROOT_DIR, dateDir);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `${run.runId}.json`);
    await writeFile(filePath, JSON.stringify(run, null, 2), "utf-8");
    return filePath;
  },
};

/** "2026-05-12T10:30:00+08:00" → "20260512". */
function dateStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return "unknown-date";
  }
  // Use UTC date to keep deterministic; the file's metadata still has the
  // original ISO with TZ.
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}
