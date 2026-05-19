/**
 * RunStore interface — pluggable audit persistence.
 *
 * Filesystem impl ships in `./filesystem.ts`. External stores (OpenSearch,
 * ClickHouse, object storage) are stubbed in `./external.ts` to document the
 * swap surface — Neo4j write-back is forbidden per SPEC §2 Non-goals.
 */

import type {
  RuleCheckBatchRunAudited,
  RuleCheckRunAudited,
} from "../types-audited";
import type { RuleDecision } from "../types";

export interface RunQuery {
  fromDate?: string;     // YYYYMMDD or ISO-8601
  toDate?: string;
  decision?: RuleDecision;
  client?: string;
  ruleId?: string;
  candidateId?: string;
  actionRef?: string;
  limit?: number;
  offset?: number;
}

export interface RunIndexEntry {
  runId: string;
  batchId?: string;
  timestamp: string;       // ISO-8601
  date: string;            // YYYYMMDD
  client: string;
  actionRef: string;
  ruleId: string;
  candidateId: string;
  decision: RuleDecision;
  /** Absolute path to the per-run JSON file. */
  path: string;
}

export interface RunStore {
  name: string;
  writeRun(run: RuleCheckRunAudited): Promise<string>;
  writeBatch(batch: RuleCheckBatchRunAudited): Promise<string>;
  listRuns(query: RunQuery): Promise<RunIndexEntry[]>;
  getRun(runId: string): Promise<RuleCheckRunAudited | null>;
  getBatch(batchId: string): Promise<RuleCheckBatchRunAudited | null>;
}

export { filesystemRunStore } from "./filesystem";
