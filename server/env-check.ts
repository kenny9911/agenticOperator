// Boot-time env validation.
//
// Catches the most common partner-deploy mistakes (forgot to copy .env.example,
// pasted placeholders verbatim, etc.) before they manifest as cryptic errors
// deep inside an agent run.
//
// Called by:
//   - scripts/check-env.mjs  (preflight before `npm run setup`)
//   - server/init.ts:bootOnce (first request to /api/inngest)
//
// Philosophy: development warns loudly so a fresh clone can still boot; production
// fails fast when RAAS-v1 runtime dependencies are missing or still set to dev /
// placeholder values. Required = "without this, the app cannot serve a single
// useful request"; production-required = "without this, the six RAAS-v1 agents
// cannot run reliably after deployment".

export type EnvCheckResult = {
  isProduction: boolean;
  ok: boolean;
  productionOk: boolean;
  required: { name: string; present: boolean; reason: string }[];
  productionRequired: { name: string; present: boolean; reason: string }[];
  recommended: { name: string; present: boolean; reason: string }[];
};

type EnvRequirement = {
  name: string;
  reason: string;
  altOf?: string | readonly string[];
  disallowValues?: readonly string[];
};

const REQUIRED: readonly EnvRequirement[] = [
  {
    name: "DATABASE_URL",
    reason: "Local Postgres conn string for AO's operational state (Prisma); port 5433.",
  },
] as const;

const PRODUCTION_REQUIRED: readonly EnvRequirement[] = [
  {
    name: "INNGEST_BASE_URL",
    reason: "RAAS-v1 event dispatch and monitor reads need a reachable Inngest server.",
  },
  {
    name: "INNGEST_EVENT_KEY",
    reason: "Production Inngest must not use the dev event key.",
    disallowValues: ["dev"],
  },
  {
    name: "INNGEST_SIGNING_KEY",
    reason: "Production Inngest callback signing must not use the dev signing key.",
    disallowValues: ["dev"],
  },
  {
    name: "INNGEST_SERVE_ORIGIN",
    altOf: "INNGEST_SERVE_HOST",
    reason: "Inngest needs the public/LAN callback origin for the AO /api/inngest endpoint.",
  },
  {
    name: "RAAS_POSTGRES_URL",
    altOf: "RAAS_PG_URL",
    reason: "Partner Postgres dual-write target. Save-candidate / match-result writes fail without it.",
  },
  {
    name: "MINIO_ENDPOINT",
    reason: "Resume parser needs the resume object store endpoint.",
  },
  {
    name: "MINIO_ACCESS_KEY",
    reason: "Resume parser needs object store credentials.",
  },
  {
    name: "MINIO_SECRET_KEY",
    reason: "Resume parser needs object store credentials.",
  },
  {
    name: "ROBOHIRE_API_KEY",
    reason: "RoboHire parse/match/invite calls fail without it.",
  },
  {
    name: "ALLMETA_BASE_URL",
    reason: "Rule-check and entity enrichment need Allmeta/Neo4j HTTP access.",
  },
  {
    name: "ALLMETA_API_KEY",
    reason: "Rule-check and Allmeta reads/writes need a bearer token.",
  },
  {
    name: "AI_API_KEY",
    reason: "LLM gateway key (or OPENAI_API_KEY). JD generation and rule-check LLM steps need it.",
    altOf: "OPENAI_API_KEY",
  },
] as const;

const RECOMMENDED: readonly EnvRequirement[] = [
  {
    name: "INNGEST_BASE_URL",
    reason: "Inngest dev/shared server URL. Without it, event-driven flows are inert.",
  },
  {
    name: "NEXT_PUBLIC_INNGEST_URL",
    reason: "Browser-side Inngest URL (dashboard links). Set equal to INNGEST_BASE_URL.",
  },
  {
    name: "ALLMETA_BASE_URL",
    reason: "Allmeta Studio (Neo4j HTTP layer). Rule-check + entity names degrade without it.",
  },
  {
    name: "AI_API_KEY",
    reason: "LLM gateway key (or OPENAI_API_KEY). Without either, all LLM calls throw.",
    altOf: "OPENAI_API_KEY",
  },
  {
    name: "RAAS_POSTGRES_URL",
    reason: "Partner Postgres dual-write target. Save-candidate / match-result writes fail without it.",
  },
  {
    name: "MINIO_ENDPOINT",
    reason: "Resume binary fetch target. Resume parser stalls without it.",
  },
  {
    name: "ROBOHIRE_API_KEY",
    reason: "RoboHire resume parser. /parse-resume + /match-resume fail without it.",
  },
] as const;

// Placeholder values from .env.example that should never make it to prod.
const PLACEHOLDER_MARKERS = [
  "replace-with",
  "replace_with",
  "<shared-inngest",
  "<this-machine",
  "<minio-host>",
  "<partner-host>",
  "/absolute/path/to/",
  "sk-replace-with",
  "rh_replace_with",
];

function looksPlaceholder(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.toLowerCase();
  return PLACEHOLDER_MARKERS.some((m) => v.includes(m.toLowerCase()));
}

function envNames(r: EnvRequirement): string[] {
  const alts = Array.isArray(r.altOf) ? r.altOf : r.altOf ? [r.altOf] : [];
  return [r.name, ...alts];
}

function displayName(r: EnvRequirement): string {
  const alts = envNames(r).slice(1);
  return alts.length > 0 ? `${r.name} (or ${alts.join(" / ")})` : r.name;
}

function valuePresent(name: string, r: EnvRequirement): boolean {
  const raw = process.env[name];
  if (!raw || looksPlaceholder(raw)) return false;
  const normalized = raw.trim().toLowerCase();
  return !(r.disallowValues ?? []).some((v) => normalized === v.toLowerCase());
}

function evaluateRequirement(r: EnvRequirement): { name: string; present: boolean; reason: string } {
  const present = envNames(r).some((name) => valuePresent(name, r));
  return { name: displayName(r), present, reason: r.reason };
}

export function checkEnv(): EnvCheckResult {
  const isProduction = process.env.NODE_ENV === "production";
  const required = REQUIRED.map(evaluateRequirement);
  const productionRequired = PRODUCTION_REQUIRED.map(evaluateRequirement);
  const recommended = RECOMMENDED.map(evaluateRequirement);

  const requiredOk = required.every((r) => r.present);
  const productionOk = productionRequired.every((r) => r.present);
  const ok = requiredOk && (!isProduction || productionOk);
  return { isProduction, ok, productionOk, required, productionRequired, recommended };
}

/** Print a colored table to stderr. Returns true if all REQUIRED vars present. */
export function printEnvCheck(result: EnvCheckResult): void {
  const reset = "\x1b[0m";
  const red = "\x1b[31m";
  const yellow = "\x1b[33m";
  const green = "\x1b[32m";
  const dim = "\x1b[2m";

  const tick = `${green}✓${reset}`;
  const cross = `${red}✗${reset}`;
  const warn = `${yellow}!${reset}`;

  console.error(`\n${dim}── env check ──────────────────────────────${reset}`);
  console.error(`${dim}REQUIRED${reset}`);
  for (const r of result.required) {
    const icon = r.present ? tick : cross;
    console.error(`  ${icon} ${r.name}${r.present ? "" : `  ${dim}${r.reason}${reset}`}`);
  }
  if (result.isProduction) {
    console.error(`${dim}PRODUCTION REQUIRED${reset}`);
    for (const r of result.productionRequired) {
      const icon = r.present ? tick : cross;
      console.error(`  ${icon} ${r.name}${r.present ? "" : `  ${dim}${r.reason}${reset}`}`);
    }
  }
  console.error(`${dim}RECOMMENDED${reset}`);
  for (const r of result.recommended) {
    const icon = r.present ? tick : warn;
    console.error(`  ${icon} ${r.name}${r.present ? "" : `  ${dim}${r.reason}${reset}`}`);
  }
  if (!result.ok) {
    console.error(`\n${red}✗ Required env vars missing or set to placeholder values.${reset}`);
    console.error(`${dim}  Fix .env.local and re-run. See .env.example for the full template.${reset}\n`);
  } else {
    console.error(`${green}✓ All required env vars present.${reset}\n`);
  }
}

/** Throws on missing REQUIRED vars. Used by server boot. */
export function assertRequiredEnv(): void {
  const result = checkEnv();
  if (!result.ok) {
    const missing = [
      ...result.required.filter((r) => !r.present),
      ...(result.isProduction ? result.productionRequired.filter((r) => !r.present) : []),
    ].map((r) => r.name);
    throw new Error(
      `Required env vars missing or placeholder-valued: ${missing.join(", ")}. ` +
        `Edit .env.local — see .env.example for the template.`,
    );
  }
}

/** Throws only in NODE_ENV=production when RAAS-v1 runtime dependencies are absent. */
export function assertProductionRuntimeEnv(result = checkEnv()): void {
  if (!result.isProduction || result.ok) return;
  const missing = [
    ...result.required.filter((r) => !r.present),
    ...result.productionRequired.filter((r) => !r.present),
  ].map((r) => r.name);
  throw new Error(
    `Production env vars missing or placeholder/dev-valued: ${missing.join(", ")}. ` +
      `Fix the deployment env before serving RAAS-v1 traffic.`,
  );
}
