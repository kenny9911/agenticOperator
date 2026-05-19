/**
 * RunStore interface — pluggable audit persistence.
 *
 * MVP ships `FilesystemRunStore` writing JSON to disk. FULL impl will add a
 * Neo4j-backed `RuleCheckResult` DataObject (via Ontology API) for cross-
 * service query + analytics.
 */

import type { RuleCheckRun } from "../types";

export interface RunStore {
  name: string;
  /** Persist; returns the absolute path or PK that locates this run. */
  write(run: RuleCheckRun): Promise<string>;
}

export { filesystemRunStore } from "./filesystem";
export { neo4jRunStore } from "./neo4j";
