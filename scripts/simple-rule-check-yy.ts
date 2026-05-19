#!/usr/bin/env node
/**
 * Simple Rule Check CLI.
 *
 * Usage:
 *   npm run simple-rule-check -- --rule 10-7 --candidate C-MVP-001 \
 *                                --client 腾讯 --job JR-MVP-TENCENT-001 \
 *                                [--department WXG] [--domain RAAS-v1] \
 *                                [--output pretty|json|decision-only]
 *
 * Outputs the RuleCheckRun (or just the decision in decision-only mode).
 * Always writes a brief audit-path note to stderr.
 */

import { checkRule } from "../lib/simple-rule-check";

interface CliArgs {
  rule: string;
  candidate: string;
  client: string;
  department?: string;
  job?: string;
  domain: string;
  output: "pretty" | "json" | "decision-only";
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const rule = get("--rule");
  const candidate = get("--candidate");
  const client = get("--client");
  if (!rule) die("missing --rule");
  if (!candidate) die("missing --candidate");
  if (!client) die("missing --client");
  const output = (get("--output") ?? "pretty") as CliArgs["output"];
  if (!["pretty", "json", "decision-only"].includes(output)) {
    die(`invalid --output value: ${output}`);
  }
  return {
    rule: rule!,
    candidate: candidate!,
    client: client!,
    department: get("--department"),
    job: get("--job"),
    domain: get("--domain") ?? "RAAS-v1",
    output,
  };
}

function die(msg: string): never {
  process.stderr.write(
    `\nERROR: ${msg}\n\n` +
      `Usage: npm run simple-rule-check -- \\\n` +
      `  --rule <ruleId>           e.g. 10-7\n` +
      `  --candidate <pk>          e.g. C-MVP-001\n` +
      `  --client <name>           e.g. 腾讯\n` +
      `  [--job <ref>]             e.g. JR-MVP-TENCENT-001\n` +
      `  [--department <name>]     e.g. WXG\n` +
      `  [--domain <name>]         default RAAS-v1\n` +
      `  [--output pretty|json|decision-only]   default pretty\n`,
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const args = parseArgs();

  const run = await checkRule({
    actionRef: "matchResume",
    ruleId: args.rule,
    candidateId: args.candidate,
    jobRef: args.job,
    scope: { client: args.client, department: args.department },
    domain: args.domain,
  });

  if (args.output === "decision-only") {
    process.stdout.write(`${run.finalDecision.decision}\n`);
  } else if (args.output === "json") {
    process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
  } else {
    printPretty(run);
  }
  if (run.auditPath) {
    process.stderr.write(`\nAudit: ${run.auditPath}\n`);
  }
}

function printPretty(run: import("../lib/simple-rule-check").RuleCheckRun): void {
  const fd = run.finalDecision;
  const parsed = run.llmParsed;
  const v = run.validation;

  process.stdout.write(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  process.stdout.write(`Rule check — ${run.input.actionRef}/${run.input.ruleId}\n`);
  process.stdout.write(
    `Candidate: ${run.input.candidateId}   Job: ${run.input.jobRef ?? "(none)"}\n`,
  );
  process.stdout.write(
    `Client: ${run.input.scope.client}${run.input.scope.department ? ` / ${run.input.scope.department}` : ""}\n`,
  );
  process.stdout.write(
    `Domain: ${run.input.domain ?? "RAAS-v1"}   Run: ${run.runId}   Time: ${run.timestamp}\n`,
  );
  process.stdout.write(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`);

  process.stdout.write(`Decision:  ${fd.decision.toUpperCase()}`);
  if (fd.overrideReason) process.stdout.write(`  (override: ${fd.overrideReason})`);
  process.stdout.write(`\n`);
  if (parsed) {
    process.stdout.write(`Confidence: ${(parsed.confidence * 100).toFixed(0)}%\n`);
    process.stdout.write(`Root cause: ${parsed.rootCause}\n`);
    process.stdout.write(`Next action: ${parsed.nextAction}\n`);
  }
  process.stdout.write(`\nValidation:\n`);
  process.stdout.write(`  rule_id exists:       ${v.ruleIdExists ? "✓" : "✗"}\n`);
  process.stdout.write(`  evidence grounded:    ${v.evidenceGrounded ? "✓" : "✗"}\n`);
  process.stdout.write(`  schema valid:         ${v.schemaValid ? "✓" : "✗"}\n`);
  process.stdout.write(`  block semantic:       ${v.blockSemanticCheck}\n`);
  if (v.failures.length > 0) {
    process.stdout.write(`  failures:\n`);
    for (const f of v.failures) process.stdout.write(`    - ${f}\n`);
  }
  if (parsed && parsed.evidence.length > 0) {
    process.stdout.write(`\nEvidence:\n`);
    for (const ev of parsed.evidence) {
      const val = JSON.stringify(ev.value);
      process.stdout.write(`  - ${ev.objectType}/${ev.objectId}.${ev.field} = ${val.length > 80 ? val.slice(0, 80) + "…" : val}\n`);
    }
  }
  process.stdout.write(`\nLLM: model=${run.llmRaw.model}  in=${run.llmRaw.inputTokens}tok  out=${run.llmRaw.outputTokens}tok  latency=${run.llmRaw.latencyMs}ms\n`);
}

main().catch((err) => {
  process.stderr.write(`\n[simple-rule-check] FATAL: ${(err as Error).message}\n`);
  if ((err as Error).stack) {
    process.stderr.write((err as Error).stack + "\n");
  }
  process.exit(1);
});
