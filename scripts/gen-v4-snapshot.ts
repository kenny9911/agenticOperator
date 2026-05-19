#!/usr/bin/env node
/**
 * CLI: generate one Action's v4 ActionObject snapshot.
 *
 * Usage:
 *   npm run gen:v4-snapshot -- --action matchResume --domain RAAS-v1
 *   npm run gen:v4-snapshot -- --action matchResume --domain RAAS-v1 --output generated/v4/match-resume.action-object.ts
 *
 * Strategy: v4-4 only (hand-written Chinese fill-in template). The emitted
 * `prompt` field contains placeholders to be substituted at consumption time
 * via `fillRuntimeInput`:
 *
 *   - matchResume → {{CLIENT}} / {{JOB}} / {{RESUME}} (three hierarchical slots)
 *   - other actions → {{RUNTIME_INPUT}} (single slot)
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { OntologyGenError } from "../lib/ontology-gen/errors";
import { fetchAction } from "../lib/ontology-gen/fetch";
import { RUNTIME_INPUT_PLACEHOLDER } from "../lib/ontology-gen/v4/assemble";
import { assembleActionObjectV4_4 } from "../lib/ontology-gen/v4/assemble-v4-4";
import {
  MATCH_RESUME_HIERARCHY_SENTINEL,
  isMatchResumeAction,
} from "../lib/ontology-gen/v4/placeholders";
import type { ActionObjectV4, EnrichedAction } from "../lib/ontology-gen/v4/types";

interface CliFlags {
  action?: string;
  domain: string;
  output?: string;
  typesImport: string;
  apiBase?: string;
  timeoutMs?: number;
  quiet: boolean;
}

const USAGE = `Usage:
  npm run gen:v4-snapshot -- --action <name-or-id> [options]

Required:
  --action <name|id>          Action name (e.g. matchResume) or numeric id

Options:
  --domain <domain>           Default: RAAS-v1
  --output <path>             Default: generated/v4/<kebab(name)>.action-object.ts
  --types-import <path>       Default: ./action-object-v4.types
  --api-base <url>            Default: env ONTOLOGY_API_BASE
  --timeout-ms <n>            Default: 8000
  --quiet                     Suppress progress logs

Env:
  ONTOLOGY_API_BASE           e.g. http://localhost:3500
  ONTOLOGY_API_TOKEN          Bearer token (required)

Exit codes:
  0  success
  1  fetch/assemble/emit/write failure
  2  CLI usage error`;

main().catch((err: unknown) => {
  if (err instanceof OntologyGenError) {
    const detailsBlock = err.details ? `\n${JSON.stringify(err.details, null, 2)}` : "";
    process.stderr.write(`${err.name}: ${err.message}${detailsBlock}\n`);
    process.exit(1);
  }
  process.stderr.write(`Unexpected error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});

async function main(): Promise<void> {
  const flags = parseArgv(process.argv.slice(2));

  if (!flags.action) {
    usageError("missing --action");
  }

  const apiToken = process.env["ONTOLOGY_API_TOKEN"] ?? "";
  const apiBase = flags.apiBase ?? process.env["ONTOLOGY_API_BASE"];

  if (!apiToken) {
    usageError("ONTOLOGY_API_TOKEN env var is not set (configure via .env.local — see .env.example)");
  }
  if (!apiBase) {
    usageError("ONTOLOGY_API_BASE env var is not set (or pass --api-base) — see .env.example");
  }

  if (!flags.quiet) {
    process.stderr.write(
      `[gen:v4-snapshot] fetching ${apiBase}/api/v1/ontology/actions/${flags.action!}/rules?domain=${flags.domain}\n`,
    );
  }

  const action = await fetchAction({
    actionRef: flags.action!,
    domain: flags.domain,
    apiBase,
    apiToken,
    timeoutMs: flags.timeoutMs,
  });

  const enriched: EnrichedAction = {
    action,
    dataObjectSchemas: {},
    eventSchemas: {},
  };

  // For matchResume, embed the three-placeholder hierarchical sentinel.
  // For all other actions, fall back to the single {{RUNTIME_INPUT}} placeholder.
  const sentinel = isMatchResumeAction(action)
    ? MATCH_RESUME_HIERARCHY_SENTINEL
    : RUNTIME_INPUT_PLACEHOLDER;

  const obj = assembleActionObjectV4_4({
    enriched,
    domain: flags.domain,
    runtimeInput: sentinel,
  });

  const output = flags.output ?? `generated/v4/${toKebab(action.name)}.action-object.ts`;
  const source = emitSnapshot(obj, action.name, flags.typesImport);

  const dir = dirname(output);
  mkdirSync(dir, { recursive: true });
  writeFileSync(output, source, "utf8");

  if (!flags.quiet) {
    process.stderr.write(
      `[gen:v4-snapshot] wrote ${output} (action=${obj.meta.actionName} id=${obj.meta.actionId} strategy=${obj.meta.promptStrategy})\n`,
    );
  }
}

function emitSnapshot(obj: ActionObjectV4, actionName: string, typesImport: string): string {
  const exportName = `${toLowerCamel(actionName)}ActionObject`;
  const placeholderNote = isMatchResumeAction({ name: actionName })
    ? "// prompt contains four placeholders: {{CLIENT}} / {{JOB}} / {{RESUME}} / {{CURRENT_TIME}}.\n// Call fillRuntimeInput(obj, { job, resume }, { client, department? }) at consumption time;\n// {{CURRENT_TIME}} is substituted automatically with the current Beijing time."
    : "// prompt contains placeholders: {{RUNTIME_INPUT}} + {{CURRENT_TIME}}.\n// Call fillRuntimeInput(obj, <string-or-object>, { client, department? }) at consumption time;\n// {{CURRENT_TIME}} is substituted automatically with the current Beijing time.";

  return [
    `// AUTO-GENERATED by scripts/gen-v4-snapshot.ts at ${obj.meta.compiledAt}`,
    `// Source: action=${obj.meta.actionName} id=${obj.meta.actionId} domain=${obj.meta.domain} strategy=${obj.meta.promptStrategy}`,
    placeholderNote,
    `// DO NOT EDIT — regenerate via: npm run gen:v4-snapshot -- --action ${obj.meta.actionName}`,
    ``,
    `import type { ActionObjectV4 } from "${typesImport}";`,
    ``,
    `export const ${exportName}: ActionObjectV4 = {`,
    `  prompt: ${JSON.stringify(obj.prompt)},`,
    `  meta: ${JSON.stringify(obj.meta, null, 2).replace(/\n/g, "\n  ")},`,
    `};`,
    ``,
    `export default ${exportName};`,
    ``,
  ].join("\n");
}

function parseArgv(argv: string[]): CliFlags {
  const flags: CliFlags = { domain: "RAAS-v1", typesImport: "./action-object-v4.types", quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--action":
        flags.action = nextValue(argv, i++);
        break;
      case "--domain":
        flags.domain = nextValue(argv, i++);
        break;
      case "--output":
        flags.output = nextValue(argv, i++);
        break;
      case "--types-import":
        flags.typesImport = nextValue(argv, i++);
        break;
      case "--api-base":
        flags.apiBase = nextValue(argv, i++);
        break;
      case "--timeout-ms": {
        const v = nextValue(argv, i++);
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) {
          usageError(`--timeout-ms must be a positive number, got "${v}"`);
        }
        flags.timeoutMs = n;
        break;
      }
      case "--quiet":
        flags.quiet = true;
        break;
      case "-h":
      case "--help":
        process.stdout.write(`${USAGE}\n`);
        process.exit(0);
      default:
        usageError(`unknown flag: ${arg}`);
    }
  }
  return flags;
}

function nextValue(argv: string[], i: number): string {
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) {
    usageError(`flag ${argv[i]} expects a value`);
  }
  return v!;
}

function usageError(msg: string): never {
  process.stderr.write(`error: ${msg}\n\n${USAGE}\n`);
  process.exit(2);
}

function toKebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

function toLowerCamel(name: string): string {
  if (name.length === 0) return name;
  return name[0]!.toLowerCase() + name.slice(1);
}
