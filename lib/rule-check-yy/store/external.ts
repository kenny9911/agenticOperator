/**
 * External RunStore stubs — documents migration shape from filesystem to a
 * queryable external store. Implementations live elsewhere (different repo /
 * infra) and just need to fulfill the `RunStore` interface.
 *
 * Forbidden: writing audit data into the Ontology API / Neo4j (locked
 * decision in SPEC §2 Non-goals).
 */

import type {
  RuleCheckBatchRunAudited,
  RuleCheckRunAudited,
} from "../types-audited";
import type { RunIndexEntry, RunQuery, RunStore } from "./index";

const NOT_IMPLEMENTED = (storeName: string) =>
  new Error(
    `${storeName} is not implemented yet — filesystem store is the default. ` +
      `Swap by implementing the RunStore interface (see ./index.ts).`,
  );

export const openSearchRunStore: RunStore = {
  name: "opensearch",
  async writeRun(_run: RuleCheckRunAudited): Promise<string> {
    throw NOT_IMPLEMENTED("OpenSearchRunStore");
  },
  async writeBatch(_batch: RuleCheckBatchRunAudited): Promise<string> {
    throw NOT_IMPLEMENTED("OpenSearchRunStore");
  },
  async listRuns(_query: RunQuery): Promise<RunIndexEntry[]> {
    throw NOT_IMPLEMENTED("OpenSearchRunStore");
  },
  async getRun(_runId: string): Promise<RuleCheckRunAudited | null> {
    throw NOT_IMPLEMENTED("OpenSearchRunStore");
  },
  async getBatch(_batchId: string): Promise<RuleCheckBatchRunAudited | null> {
    throw NOT_IMPLEMENTED("OpenSearchRunStore");
  },
};

export const clickHouseRunStore: RunStore = {
  name: "clickhouse",
  async writeRun(_run: RuleCheckRunAudited): Promise<string> {
    throw NOT_IMPLEMENTED("ClickHouseRunStore");
  },
  async writeBatch(_batch: RuleCheckBatchRunAudited): Promise<string> {
    throw NOT_IMPLEMENTED("ClickHouseRunStore");
  },
  async listRuns(_query: RunQuery): Promise<RunIndexEntry[]> {
    throw NOT_IMPLEMENTED("ClickHouseRunStore");
  },
  async getRun(_runId: string): Promise<RuleCheckRunAudited | null> {
    throw NOT_IMPLEMENTED("ClickHouseRunStore");
  },
  async getBatch(_batchId: string): Promise<RuleCheckBatchRunAudited | null> {
    throw NOT_IMPLEMENTED("ClickHouseRunStore");
  },
};
