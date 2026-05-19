#!/usr/bin/env node
/**
 * Dumps the current `generatePrompt({ actionRef: "matchResume", client: "腾讯" })`
 * output to disk so we can audit size + section breakdown without burning a
 * provider request.
 *
 * Two artifacts:
 *   - data/dev/match-resume.templated.md     (no runtimeInput substituted)
 *   - data/dev/match-resume.section-stats.json   (per-section sizes + totals)
 *
 * Run: `npm run dev:dump-match-resume-prompt`
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { generatePrompt } from "../lib/ontology-gen/v4/generate-prompt";

const REPO_ROOT = resolve(__dirname, "..");
const OUT_DIR = resolve(REPO_ROOT, "data/dev");

function approxTokens(s: string): number {
  // Same heuristic as the orchestrator's token probe.
  const cjk = (s.match(/[一-龥]/gu) ?? []).length;
  const rest = s.length - cjk;
  return cjk + Math.ceil(rest / 4);
}

function splitBySectionHeader(prompt: string): Array<{ header: string; body: string; chars: number; tokens: number }> {
  const out: Array<{ header: string; body: string; chars: number; tokens: number }> = [];
  const lines = prompt.split(/\n/);
  let currentHeader = "(preamble)";
  let buf: string[] = [];

  const flush = () => {
    if (buf.length === 0 && currentHeader === "(preamble)") return;
    const body = buf.join("\n");
    out.push({ header: currentHeader, body, chars: body.length, tokens: approxTokens(body) });
    buf = [];
  };

  for (const line of lines) {
    if (/^##\s/.test(line)) {
      flush();
      currentHeader = line.replace(/^##\s+/, "").trim();
    } else {
      buf.push(line);
    }
  }
  flush();
  return out;
}

async function main(): Promise<void> {
  const actionRef = "matchResume";
  const client = "腾讯";
  const domain = "RAAS-v1";

  const apiBase = process.env["ONTOLOGY_API_BASE"];
  const apiToken = process.env["ONTOLOGY_API_TOKEN"];
  if (!apiBase || !apiToken) {
    process.stderr.write("ERROR: ONTOLOGY_API_BASE / ONTOLOGY_API_TOKEN must be set in .env.local\n");
    process.exit(2);
  }

  process.stderr.write(`Calling generatePrompt(${actionRef}, ${client}, ${domain}) ...\n`);
  const t0 = Date.now();
  const obj = await generatePrompt({ actionRef, client, domain, apiBase, apiToken });
  const fetchMs = Date.now() - t0;
  process.stderr.write(`  fetched in ${fetchMs}ms\n`);

  const prompt = obj.prompt;
  const totalChars = prompt.length;
  const totalTokens = approxTokens(prompt);
  const sections = splitBySectionHeader(prompt);

  mkdirSync(OUT_DIR, { recursive: true });

  const promptPath = resolve(OUT_DIR, "match-resume.templated.md");
  writeFileSync(promptPath, prompt, "utf-8");
  process.stderr.write(`  wrote prompt: ${promptPath}\n`);

  const statsPath = resolve(OUT_DIR, "match-resume.section-stats.json");
  const stats = {
    generatedAt: new Date().toISOString(),
    actionRef,
    client,
    domain,
    fetchMs,
    total: { chars: totalChars, tokens: totalTokens, lines: prompt.split("\n").length },
    sectionCount: sections.length,
    sections: sections.map((s) => ({
      header: s.header,
      chars: s.chars,
      tokens: s.tokens,
      lines: s.body.split("\n").length,
    })),
    meta: obj.meta,
  };
  writeFileSync(statsPath, JSON.stringify(stats, null, 2), "utf-8");
  process.stderr.write(`  wrote stats: ${statsPath}\n`);

  process.stdout.write(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  process.stdout.write(`generatePrompt(${actionRef}, ${client}) — size report\n`);
  process.stdout.write(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`);
  process.stdout.write(`Total:   ${totalChars} chars  ~${totalTokens} tokens  ${prompt.split("\n").length} lines\n`);
  process.stdout.write(`Action:  id=${obj.meta.actionId} name=${obj.meta.actionName} strategy=${obj.meta.promptStrategy}\n\n`);

  process.stdout.write(`Sections (${sections.length}):\n`);
  process.stdout.write(`  ${"#".padStart(3)}  ${"chars".padStart(7)}  ${"tokens".padStart(7)}  ${"lines".padStart(5)}  header\n`);
  process.stdout.write(`  ${"-".repeat(3)}  ${"-".repeat(7)}  ${"-".repeat(7)}  ${"-".repeat(5)}  ${"-".repeat(40)}\n`);
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i]!;
    const lineCount = s.body.split("\n").length;
    process.stdout.write(
      `  ${String(i + 1).padStart(3)}  ${String(s.chars).padStart(7)}  ${String(s.tokens).padStart(7)}  ${String(lineCount).padStart(5)}  ${s.header}\n`,
    );
  }

  process.stdout.write(`\nLargest 3 sections:\n`);
  const top3 = [...sections].sort((a, b) => b.chars - a.chars).slice(0, 3);
  for (const s of top3) {
    process.stdout.write(`  - "${s.header}": ${s.chars} chars (${((s.chars / totalChars) * 100).toFixed(1)}%)\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`\nFATAL: ${(err as Error).message}\n`);
  if ((err as Error).stack) process.stderr.write((err as Error).stack + "\n");
  process.exit(1);
});
