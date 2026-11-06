#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function parseEnv(source) {
  const values = {};
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

const fileFlag = process.argv.indexOf("--env-file");
const envPath = resolve(process.cwd(), fileFlag >= 0 ? process.argv[fileFlag + 1] : ".env.deploy");
if (!existsSync(envPath)) {
  console.error(`[deploy-check] ${envPath} does not exist.`);
  console.error("[deploy-check] Copy .env.deploy.example to .env.deploy and replace every placeholder.");
  process.exit(1);
}

const fileEnv = parseEnv(readFileSync(envPath, "utf8"));
const env = { ...fileEnv, ...process.env };
const errors = [];
const warnings = [];

const placeholders = [
  /replace[-_]/i,
  /change[-_]?me/i,
  /<[^>]+>/,
  /\.example(?:\/|$)/i,
  /192\.0\.2\.10/,
];

function validValue(name) {
  const value = env[name]?.trim();
  return Boolean(value) && !placeholders.some((marker) => marker.test(value));
}

function requireValue(name, reason) {
  if (!validValue(name)) errors.push(`${name}: ${reason}`);
}

function requireUrl(name, protocols) {
  if (!validValue(name)) return;
  try {
    const parsed = new URL(env[name]);
    if (!protocols.includes(parsed.protocol)) {
      errors.push(`${name}: expected ${protocols.join(" or ")}, received ${parsed.protocol}`);
    }
  } catch {
    errors.push(`${name}: invalid URL`);
  }
}

for (const [name, reason] of [
  ["AO_PUBLIC_ORIGIN", "browser-reachable AO origin is required"],
  ["INNGEST_PUBLIC_ORIGIN", "browser/partner-reachable Inngest origin is required"],
  ["AO_POSTGRES_USER", "AO Postgres user is required"],
  ["AO_POSTGRES_PASSWORD", "AO Postgres password is required"],
  ["AO_POSTGRES_DB", "AO Postgres database is required"],
  ["DATABASE_URL", "container Postgres URL is required"],
  ["INNGEST_EVENT_KEY", "set a non-dev local event key"],
  ["INNGEST_SIGNING_KEY", "set a non-dev local signing key"],
  ["ALLMETA_BASE_URL", "Allmeta/Neo4j gateway is required for full functionality"],
  ["ALLMETA_API_KEY", "Allmeta bearer token is required"],
  ["ROBOHIRE_API_KEY", "RoboHire parse/match key is required"],
  ["RAAS_POSTGRES_URL", "partner Postgres dual-write URL is required"],
  ["MINIO_ENDPOINT", "resume object-store host is required"],
  ["MINIO_ACCESS_KEY", "MinIO access key is required"],
  ["MINIO_SECRET_KEY", "MinIO secret key is required"],
  ["AGENT_EXECUTION_API_KEY", "protect the agent execution API"],
]) {
  requireValue(name, reason);
}

// The agent factory is NOT part of a normal deployment (it lives in its own
// monorepo now) — its pages and /api/factory-* routes 404 unless explicitly
// switched on. Only demand an admin token when someone turns it back on.
const factoryOn = ["1", "true"].includes(String(env.FACTORY_ENABLED ?? "").toLowerCase());
if (factoryOn) {
  requireValue("FACTORY_ADMIN_TOKEN", "protect factory administration APIs (FACTORY_ENABLED=1)");
  if (String(env.NEXT_PUBLIC_FACTORY_ENABLED ?? "") !== "1") {
    warnings.push(
      "FACTORY_ENABLED=1 but NEXT_PUBLIC_FACTORY_ENABLED is not 1 — the factory will serve but stay hidden in the left nav (it is baked in at image build time).",
    );
  }
}

if (!validValue("AI_API_KEY") && !validValue("OPENAI_API_KEY")) {
  errors.push("AI_API_KEY or OPENAI_API_KEY: an LLM credential is required");
}
if (validValue("AI_API_KEY")) {
  requireValue("AI_BASE_URL", "AI_BASE_URL is required with AI_API_KEY");
  requireValue("AI_MODEL", "AI_MODEL is required with AI_API_KEY");
}

requireUrl("AO_PUBLIC_ORIGIN", ["http:", "https:"]);
requireUrl("INNGEST_PUBLIC_ORIGIN", ["http:", "https:"]);
requireUrl("DATABASE_URL", ["postgres:", "postgresql:"]);
requireUrl("RAAS_POSTGRES_URL", ["postgres:", "postgresql:"]);
requireUrl("ALLMETA_BASE_URL", ["http:", "https:"]);
requireUrl("ROBOHIRE_API_BASE_URL", ["http:", "https:"]);
if (validValue("AI_BASE_URL")) requireUrl("AI_BASE_URL", ["http:", "https:"]);

// Inngest mode sanity: without the bundled-inngest profile the compose file
// starts NO event engine, so shared-instance URLs must be configured — a
// missing COMPOSE_PROFILES otherwise silently drops the inngest service.
const composeProfiles = (env.COMPOSE_PROFILES ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const bundledInngest = composeProfiles.includes("bundled-inngest");
if (!bundledInngest && (!validValue("INNGEST_BASE_URL") || !validValue("INNGEST_SERVE_ORIGIN"))) {
  errors.push(
    "Inngest mode: COMPOSE_PROFILES lacks 'bundled-inngest' and INNGEST_BASE_URL/INNGEST_SERVE_ORIGIN are unset — no event engine would run. Set COMPOSE_PROFILES=bundled-inngest, or configure both shared-instance URLs.",
  );
}
if (bundledInngest && (validValue("INNGEST_BASE_URL") || validValue("INNGEST_SERVE_ORIGIN"))) {
  warnings.push(
    "bundled-inngest profile is enabled but INNGEST_BASE_URL/INNGEST_SERVE_ORIGIN overrides are set; the overrides win — confirm this is intended",
  );
}

if (env.INNGEST_EVENT_KEY?.trim().toLowerCase() === "dev") {
  errors.push("INNGEST_EVENT_KEY: literal 'dev' is rejected for production deployment");
}
if (env.INNGEST_SIGNING_KEY?.trim().toLowerCase() === "dev") {
  errors.push("INNGEST_SIGNING_KEY: literal 'dev' is rejected for production deployment");
}
if (/^(1|true|on)$/i.test(env.STUB_AGENTS ?? "")) {
  errors.push("STUB_AGENTS must remain disabled in production");
}
if (/^(1|true|on)$/i.test(env.RULE_CHECK_BYPASS ?? "")) {
  errors.push("RULE_CHECK_BYPASS must remain disabled in production");
}
if (/^(1|true|on)$/i.test(env.AO_ENABLE_UNSAFE_DEV_ROUTES ?? "")) {
  errors.push("AO_ENABLE_UNSAFE_DEV_ROUTES must remain disabled in production");
}
if (Number(env.LOG_EVENT_RETENTION_DAYS ?? 0) > 0) {
  warnings.push("LOG_EVENT_RETENTION_DAYS is non-zero; old unified logs will be deleted by policy");
}

try {
  const db = new URL(env.DATABASE_URL ?? "");
  if (db.hostname !== "ao-postgres") {
    warnings.push(`DATABASE_URL host is '${db.hostname}', not the bundled 'ao-postgres' service`);
  }
  if (db.hostname === "postgres") {
    errors.push(
      "DATABASE_URL host 'postgres' is ambiguous in shared-network deployments (an external container may own that name) — use the bundled service name 'ao-postgres'",
    );
  }
  if (decodeURIComponent(db.username) !== env.AO_POSTGRES_USER) {
    errors.push("DATABASE_URL username does not match AO_POSTGRES_USER");
  }
  if (decodeURIComponent(db.password) !== env.AO_POSTGRES_PASSWORD) {
    errors.push("DATABASE_URL password does not match AO_POSTGRES_PASSWORD (URL-encode special characters)");
  }
  if (db.pathname.replace(/^\//, "") !== env.AO_POSTGRES_DB) {
    errors.push("DATABASE_URL database does not match AO_POSTGRES_DB");
  }
} catch {
  // The URL error is already reported above.
}

for (const warning of warnings) console.warn(`[deploy-check] WARN: ${warning}`);
if (errors.length > 0) {
  for (const error of errors) console.error(`[deploy-check] ERROR: ${error}`);
  console.error(`[deploy-check] failed with ${errors.length} configuration error(s)`);
  process.exit(1);
}

console.log(`[deploy-check] OK: ${envPath}`);
console.log("[deploy-check] Static configuration is valid; runtime dependency health is checked after startup.");

