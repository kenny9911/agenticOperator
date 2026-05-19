#!/usr/bin/env node
/**
 * Rule Check CLI (full impl).
 *
 * Usage:
 *   npm run rule-check -- --candidate C-MVP-001 --client 腾讯 --job JR-MVP-TENCENT-001
 *                         [--rules 10-7,10-17]           # default: all action rules
 *                         [--department WXG] [--domain RAAS-v1]
 *                         [--output pretty|json|decision-only]
 *
 * Outputs the batch run (or just aggregate decision in decision-only mode).
 * Always writes audit-path notes to stderr.
 */

import { checkRules } from "../lib/rule-check";

interface CliArgs {
  candidate: string;
  client: string;
  job: string;
  rules?: string[];
  department?: string;
  domain: string;
  output: "pretty" | "json" | "decision-only";
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const candidate = get("--candidate");
  const client = get("--client");
  const job = get("--job");
  if (!candidate) die("missing --candidate");
  if (!client) die("missing --client");
  if (!job) die("missing --job (matchResume requires a job context)");
  const output = (get("--output") ?? "pretty") as CliArgs["output"];
  if (!["pretty", "json", "decision-only"].includes(output)) {
    die(`invalid --output value: ${output}`);
  }
  const rulesArg = get("--rules");
  return {
    candidate: candidate!,
    client: client!,
    job: job!,
    rules: rulesArg ? rulesArg.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    department: get("--department"),
    domain: get("--domain") ?? "RAAS-v1",
    output,
  };
}

function die(msg: string): never {
  process.stderr.write(
    `\nERROR: ${msg}\n\n` +
      `Usage: npm run rule-check -- \\\n` +
      `  --candidate <pk>          e.g. C-MVP-001\n` +
      `  --client <name>           e.g. 腾讯\n` +
      `  --job <ref>               e.g. JR-MVP-TENCENT-001\n` +
      `  [--rules <id1,id2,...>]   comma-separated (default: all action rules)\n` +
      `  [--department <name>]     e.g. WXG\n` +
      `  [--domain <name>]         default RAAS-v1\n` +
      `  [--output pretty|json|decision-only]   default pretty\n`,
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const args = parseArgs();

  const batch = await checkRules({
    actionRef: "matchResume",
    candidateId: args.candidate,
    jobRef: args.job,
    scope: { client: args.client, department: args.department },
    domain: args.domain,
    ruleIds: args.rules,
  });

  if (args.output === "decision-only") {
    process.stdout.write(`${batch.aggregateDecision.decision}\n`);
  } else if (args.output === "json") {
    process.stdout.write(`${JSON.stringify(batch, null, 2)}\n`);
  } else {
    printPretty(batch);
  }
  if (batch.auditPath) {
    process.stderr.write(`\nBatch audit: ${batch.auditPath}\n`);
  }
}

function printPretty(batch: import("../lib/rule-check").RuleCheckBatchRunAudited): void {
  process.stdout.write(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  process.stdout.write(`Rule check (full) — ${batch.input.actionRef}\n`);
  process.stdout.write(
    `Candidate: ${batch.input.candidateId}   Job: ${batch.input.jobRef ?? "(none)"}\n`,
  );
  process.stdout.write(
    `Client: ${batch.input.scope.client}${batch.input.scope.department ? ` / ${batch.input.scope.department}` : ""}\n`,
  );
  process.stdout.write(
    `Domain: ${batch.input.domain ?? "RAAS-v1"}   Batch: ${batch.batchId}   Time: ${batch.timestamp}\n`,
  );
  process.stdout.write(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`);

  const agg = batch.aggregateDecision;
  process.stdout.write(`Aggregate decision: ${agg.decision.toUpperCase()}\n`);
  if (agg.triggeredRules.length > 0) {
    process.stdout.write(`  Triggered rules: ${agg.triggeredRules.join(", ")}\n`);
  }
  if (agg.terminal) {
    process.stdout.write(`  ↯ short-circuit @ step ${agg.terminalAtStep ?? "?"} — 后续 step 跳过 LLM 调用\n`);
  }

  // Per-step LLM call summary (Path C).
  process.stdout.write(`\nLLM calls (per step):\n`);
  for (const sc of batch.stepCalls) {
    if (sc.shortCircuited) {
      process.stdout.write(`  ${sc.stepKey.padEnd(8)} SKIPPED (short-circuit)\n`);
      continue;
    }
    const raw = sc.llmRaw;
    process.stdout.write(
      `  ${sc.stepKey.padEnd(8)} model=${raw?.model ?? "?"}  in=${raw?.inputTokens ?? 0}tok  out=${raw?.outputTokens ?? 0}tok  latency=${raw?.latencyMs ?? 0}ms` +
      (sc.promptProvenance ? `  promptSha=${sc.promptProvenance.promptSha256.slice(0, 12)}…` : "") +
      (sc.triggeredShortCircuit ? `  ↯ triggered by rule ${sc.triggeredShortCircuit.byRuleId}` : "") +
      `\n`,
    );
  }
  process.stdout.write(`Ontology API calls:   ${batch.ontologyApiTrace.length}\n`);

  process.stdout.write(`\nPer-rule results (${batch.results.length}):\n`);
  for (const r of batch.results) {
    const parsed = r.llmParsed;
    const conf = parsed
      ? `${(parsed.confidence * 100).toFixed(0)}% (${r.confidenceBreakdown.source})`
      : "—";
    const v = r.validation;
    const lights = `${v.ruleIdExists ? "✓" : "✗"}${v.evidenceGrounded ? "✓" : "✗"}${v.schemaValid ? "✓" : "✗"}${v.blockSemanticCheck === "ok" ? "✓" : v.blockSemanticCheck === "warning" ? "⚠" : "–"}`;
    process.stdout.write(
      `  [${r.input.ruleId.padEnd(8)}] ${r.finalDecision.decision.toUpperCase().padEnd(14)} conf=${conf.padEnd(28)} validation=${lights}\n`,
    );
    if (r.finalDecision.overrideReason) {
      process.stdout.write(`     override: ${r.finalDecision.overrideReason}\n`);
    }
  }
}

main().catch((err) => {
  process.stderr.write(`\n[rule-check] FATAL: ${(err as Error).message}\n`);
  if ((err as Error).stack) {
    process.stderr.write((err as Error).stack + "\n");
  }
  process.exit(1);
});
