/**
 * Neo4j RunStore stub — FULL impl.
 *
 * Will POST RuleCheckResult instances to the Ontology API once that
 * DataObject schema is defined (see SPEC §14 open question #2). Deferred
 * to v1.1; throws if accidentally selected in MVP.
 */

import type { RunStore } from "./index";

export const neo4jRunStore: RunStore = {
  name: "neo4j",
  async write() {
    throw new Error(
      "neo4jRunStore is not implemented in MVP. Use filesystemRunStore.",
    );
  },
};
