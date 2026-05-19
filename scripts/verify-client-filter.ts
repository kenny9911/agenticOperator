#!/usr/bin/env node
/**
 * Verify that `applyClientFilter` (used by `assembleActionObjectV4_4` /
 * `generatePrompt`) produces a per-client rule set that exactly matches the
 * subset of API rules whose `applicableClient` is `通用` or that client.
 *
 * Run: npx tsx scripts/verify-client-filter.ts [--action matchResume] [--domain RAAS-v1]
 *
 * Emits `client-filter-report.md` in the project root with:
 *   - Full rule index from the API, grouped by `applicableClient`.
 *   - Per-client filter outputs (rule ID sets), comparing actual vs expected.
 *   - Perfect-match verdict per client.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { applyClientFilter } from "../lib/ontology-gen/compile/filter";
import { fetchAction } from "../lib/ontology-gen/fetch";
import type { ActionRule } from "../lib/ontology-gen/types.public";

interface RuleRow {
  id: string;
  stepOrder: number;
  stepName: string;
  applicableClient: string;
  name: string;
}

interface ClientResult {
  client: string;
  expected: Set<string>;
  actual: Set<string>;
  match: boolean;
  missingFromActual: string[];
  unexpectedInActual: string[];
}

main().catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});

async function main(): Promise<void> {
  const { action: actionRef, domain } = parseFlags();

  const apiBase = process.env["ONTOLOGY_API_BASE"];
  const apiToken = process.env["ONTOLOGY_API_TOKEN"] ?? "";
  if (!apiBase || !apiToken) {
    throw new Error("ONTOLOGY_API_BASE and ONTOLOGY_API_TOKEN must be set");
  }

  process.stderr.write(`[verify] fetching ${apiBase}/api/v1/ontology/actions/${actionRef}/rules?domain=${domain}\n`);
  const action = await fetchAction({ actionRef, domain, apiBase, apiToken });

  const allRows: RuleRow[] = action.actionSteps.flatMap((step) =>
    step.rules.map(
      (r): RuleRow => ({
        id: r.id,
        stepOrder: step.order,
        stepName: step.name,
        applicableClient: normalizeAc(r.applicableClient),
        name: r.businessLogicRuleName ?? "(unnamed)",
      }),
    ),
  );

  // Group by applicableClient.
  const byClient = new Map<string, RuleRow[]>();
  for (const row of allRows) {
    const k = row.applicableClient;
    if (!byClient.has(k)) byClient.set(k, []);
    byClient.get(k)!.push(row);
  }

  // For each client filter, compute expected (manual) + actual (via applyClientFilter).
  const clients = ["通用", "腾讯", "字节"];
  const results: ClientResult[] = clients.map((c) => evaluate(c, action.actionSteps, allRows));

  const report = renderReport({
    actionRef,
    actionId: action.id,
    actionName: action.name,
    domain,
    totalRules: allRows.length,
    allRows,
    byClient,
    results,
  });

  const outPath = resolve(process.cwd(), "client-filter-report.md");
  writeFileSync(outPath, report, "utf8");
  process.stderr.write(`[verify] wrote ${outPath}\n`);
  for (const r of results) {
    process.stderr.write(
      `[verify] client="${r.client}": expected=${r.expected.size} actual=${r.actual.size} match=${r.match}\n`,
    );
  }
}

function normalizeAc(ac: string | undefined): string {
  const v = (ac ?? "").trim();
  return v.length === 0 ? "(空)" : v;
}

function evaluate(
  client: string,
  steps: ReturnType<typeof fetchAction> extends Promise<infer A>
    ? A extends { actionSteps: infer S }
      ? S
      : never
    : never,
  allRows: RuleRow[],
): ClientResult {
  // Expected: rule IDs whose applicableClient is empty / "通用" / equals filter.client.
  // (Mirrors filter.ts:matchClientFilter exactly.)
  const expected = new Set(
    allRows
      .filter((r) => {
        const ac = r.applicableClient;
        return ac === "(空)" || ac === "通用" || ac === client;
      })
      .map((r) => r.id),
  );

  // Actual: apply the filter.
  const filtered = applyClientFilter(
    { actionSteps: steps } as unknown as Parameters<typeof applyClientFilter>[0],
    { client },
  );
  const actual = new Set(
    filtered.actionSteps.flatMap((s: { rules: ActionRule[] }) => s.rules.map((r) => r.id)),
  );

  const missingFromActual = [...expected].filter((id) => !actual.has(id));
  const unexpectedInActual = [...actual].filter((id) => !expected.has(id));
  const match = missingFromActual.length === 0 && unexpectedInActual.length === 0;

  return { client, expected, actual, match, missingFromActual, unexpectedInActual };
}

function renderReport(args: {
  actionRef: string;
  actionId: string;
  actionName: string;
  domain: string;
  totalRules: number;
  allRows: RuleRow[];
  byClient: Map<string, RuleRow[]>;
  results: ClientResult[];
}): string {
  const lines: string[] = [];
  lines.push(`# Client filter verification report`);
  lines.push("");
  lines.push(
    `Generated at: ${new Date().toISOString()}  ·  action=\`${args.actionName}\` (id=${args.actionId})  ·  domain=\`${args.domain}\``,
  );
  lines.push("");
  lines.push(`API returned **${args.totalRules}** rules total across all actionSteps.`);
  lines.push("");

  // Section 1: rule index grouped by applicableClient.
  lines.push(`## 1. API rules grouped by \`applicableClient\``);
  lines.push("");
  const ordered = [...args.byClient.keys()].sort((a, b) => a.localeCompare(b, "zh-Hans"));
  lines.push(`| applicableClient | rule count | rule IDs |`);
  lines.push(`|---|---:|---|`);
  for (const k of ordered) {
    const rows = args.byClient.get(k)!;
    const ids = rows.map((r) => r.id).sort().join(", ");
    lines.push(`| \`${k}\` | ${rows.length} | ${ids} |`);
  }
  lines.push("");

  // Section 2: per-client verdict.
  lines.push(`## 2. Per-client filter verdict`);
  lines.push("");
  lines.push(`Filter logic (from \`lib/ontology-gen/compile/filter.ts\`):`);
  lines.push(`- A rule is kept iff \`applicableClient\` is empty / \`"通用"\` / equals the client filter value.`);
  lines.push(`- So: \`字节\` filter ⇒ rules where applicableClient ∈ {空, 通用, 字节}.`);
  lines.push(`- And: \`腾讯\` filter ⇒ rules where applicableClient ∈ {空, 通用, 腾讯}.`);
  lines.push(`- And: \`通用\` filter ⇒ rules where applicableClient ∈ {空, 通用}.`);
  lines.push("");
  lines.push(`| client | expected | actual | match | missing | unexpected |`);
  lines.push(`|---|---:|---:|:---:|---|---|`);
  for (const r of args.results) {
    const verdict = r.match ? "✅" : "❌";
    const miss = r.missingFromActual.length === 0 ? "—" : r.missingFromActual.join(", ");
    const extra = r.unexpectedInActual.length === 0 ? "—" : r.unexpectedInActual.join(", ");
    lines.push(`| \`${r.client}\` | ${r.expected.size} | ${r.actual.size} | ${verdict} | ${miss} | ${extra} |`);
  }
  lines.push("");

  // Section 3: detailed per-client rule lists.
  lines.push(`## 3. Per-client rule sets (detail)`);
  lines.push("");
  for (const r of args.results) {
    lines.push(`### ${r.client} (${r.actual.size} rules)`);
    lines.push("");
    const rows = args.allRows.filter((row) => r.actual.has(row.id));
    rows.sort((a, b) => a.stepOrder - b.stepOrder || a.id.localeCompare(b.id));
    lines.push(`| step | rule id | applicableClient | name |`);
    lines.push(`|---:|---|---|---|`);
    for (const row of rows) {
      lines.push(
        `| ${row.stepOrder} | \`${row.id}\` | \`${row.applicableClient}\` | ${row.name} |`,
      );
    }
    lines.push("");
  }

  // Section 4: full rule index for traceability.
  lines.push(`## 4. Full API rule index (for traceability)`);
  lines.push("");
  lines.push(`| step | rule id | applicableClient | name |`);
  lines.push(`|---:|---|---|---|`);
  const sortedAll = [...args.allRows].sort(
    (a, b) => a.stepOrder - b.stepOrder || a.id.localeCompare(b.id),
  );
  for (const row of sortedAll) {
    lines.push(
      `| ${row.stepOrder} | \`${row.id}\` | \`${row.applicableClient}\` | ${row.name} |`,
    );
  }
  lines.push("");

  // Verdict summary at top? Add bold conclusion.
  lines.splice(
    3,
    0,
    "",
    `**Verdict**: ${
      args.results.every((r) => r.match)
        ? "all client filters perfectly match the API-derived expected sets ✅"
        : "drift detected — see Section 2 ❌"
    }`,
    "",
  );

  return lines.join("\n") + "\n";
}

function parseFlags(): { action: string; domain: string } {
  const argv = process.argv.slice(2);
  let action = "matchResume";
  let domain = "RAAS-v1";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--action") action = argv[++i] ?? action;
    else if (a === "--domain") domain = argv[++i] ?? domain;
  }
  return { action, domain };
}
