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
const expectedModeFlag = process.argv.indexOf("--expect-mode");
const expectedMode = expectedModeFlag >= 0 ? process.argv[expectedModeFlag + 1] : undefined;
const expectedVolumeFlag = process.argv.indexOf("--expect-volume-mode");
const expectedVolumeMode = expectedVolumeFlag >= 0 ? process.argv[expectedVolumeFlag + 1] : undefined;
if (!existsSync(envPath)) {
  console.error(`[deploy-check] ${envPath} does not exist.`);
  console.error("[deploy-check] Copy .env.deploy.example to .env.deploy and replace every placeholder.");
  process.exit(1);
}

const fileEnv = parseEnv(readFileSync(envPath, "utf8"));
// Validate exactly the file that deploy-compose.sh will consume. Falling back
// to, or overriding with, the operator's exported shell environment can make
// preflight approve one project/volume while Compose operates on another.
const env = fileEnv;
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

function hasValue(name) {
  return Boolean(env[name]?.trim());
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
requireUrl("INNGEST_BASE_URL", ["http:", "https:"]);
requireUrl("INNGEST_SERVE_ORIGIN", ["http:", "https:"]);
requireUrl("RAAS_POSTGRES_URL", ["postgres:", "postgresql:"]);
requireUrl("ALLMETA_BASE_URL", ["http:", "https:"]);
requireUrl("ROBOHIRE_API_BASE_URL", ["http:", "https:"]);
if (validValue("AI_BASE_URL")) requireUrl("AI_BASE_URL", ["http:", "https:"]);

// Deployment mode is an explicit two-state contract. Shared is the production
// default and must use the overlay; bundled is an isolated-machine opt-in. A
// half-shared/half-bundled configuration is rejected instead of guessed.
const deployMode = env.DEPLOY_MODE?.trim();
const composeProjectName = env.COMPOSE_PROJECT_NAME?.trim();
const composeProfiles = (env.COMPOSE_PROFILES ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const bundledInngest = composeProfiles.includes("bundled-inngest");

if (deployMode !== "shared" && deployMode !== "bundled") {
  errors.push("DEPLOY_MODE must be exactly 'shared' or 'bundled'");
}
if (expectedMode && deployMode !== expectedMode) {
  errors.push(`DEPLOY_MODE must be '${expectedMode}' for this command; the env file contains '${deployMode ?? ""}'`);
}
requireValue("COMPOSE_PROJECT_NAME", "an explicit deployment generation name is required; never rely on the compose default");
if (validValue("COMPOSE_PROJECT_NAME") && !/^[a-z0-9][a-z0-9_-]*$/.test(composeProjectName)) {
  errors.push("COMPOSE_PROJECT_NAME must use lowercase letters, digits, underscores or hyphens");
}
if (["agentic-operator", "ao-postgres", "steven"].includes(composeProjectName)) {
  errors.push("COMPOSE_PROJECT_NAME must identify a new deployment generation, not a legacy/default project name");
}

function parsedUrl(name) {
  if (!validValue(name)) return null;
  try {
    return new URL(env[name]);
  } catch {
    return null;
  }
}

function requireOriginOnly(name, parsed) {
  if (!parsed) return;
  if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
    errors.push(`${name} must be an origin only (scheme + host + optional port), without path/query/credentials`);
  }
}

const inngestBase = parsedUrl("INNGEST_BASE_URL");
const inngestServe = parsedUrl("INNGEST_SERVE_ORIGIN");
requireOriginOnly("INNGEST_BASE_URL", inngestBase);
requireOriginOnly("INNGEST_SERVE_ORIGIN", inngestServe);

if (deployMode === "shared") {
  if (composeProfiles.length > 0) {
    errors.push("shared mode requires COMPOSE_PROFILES to be empty; bundled-inngest must not be enabled");
  }
  requireValue("INNGEST_BASE_URL", "shared Inngest origin is required");
  requireValue("INNGEST_SERVE_ORIGIN", "shared Inngest callback origin is required");
  requireValue("RAAS_SHARED_NETWORK", "existing external Docker network is required in shared mode");
  requireValue("AO_SHARED_NETWORK_ALIAS", "AO callback alias is required in shared mode");

  const alias = env.AO_SHARED_NETWORK_ALIAS?.trim();
  const network = env.RAAS_SHARED_NETWORK?.trim();
  if (validValue("AO_SHARED_NETWORK_ALIAS") && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(alias)) {
    errors.push("AO_SHARED_NETWORK_ALIAS must be a DNS-safe single label");
  }
  if (validValue("RAAS_SHARED_NETWORK") && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(network)) {
    errors.push("RAAS_SHARED_NETWORK contains characters Docker network names do not support");
  }
  if (inngestBase && ["inngest", "app", alias].includes(inngestBase.hostname)) {
    errors.push("shared INNGEST_BASE_URL must point to the existing shared engine, not this compose project's inngest/app service");
  }
  if (inngestServe && alias && inngestServe.hostname !== alias) {
    errors.push("shared INNGEST_SERVE_ORIGIN hostname must exactly match AO_SHARED_NETWORK_ALIAS");
  }
  if (inngestServe && inngestServe.port !== "3002") {
    errors.push("shared INNGEST_SERVE_ORIGIN must use AO's container port 3002");
  }
}

if (deployMode === "bundled") {
  if (!bundledInngest || composeProfiles.length !== 1) {
    errors.push("bundled mode requires COMPOSE_PROFILES=bundled-inngest and no other profile");
  }
  if (hasValue("RAAS_SHARED_NETWORK") || hasValue("AO_SHARED_NETWORK_ALIAS")) {
    errors.push("bundled mode must not carry shared-only RAAS_SHARED_NETWORK/AO_SHARED_NETWORK_ALIAS values");
  }
  if (inngestBase?.origin !== "http://inngest:8288") {
    errors.push("bundled mode requires INNGEST_BASE_URL=http://inngest:8288");
  }
  if (inngestServe?.origin !== "http://app:3002") {
    errors.push("bundled mode requires INNGEST_SERVE_ORIGIN=http://app:3002");
  }
}

// PostgreSQL volume choice is likewise explicit. New is the safe default;
// external means the operator also adds docker-compose.reuse-postgres-volume.yml.
const volumeMode = env.AO_POSTGRES_VOLUME_MODE?.trim();
const schemaSync = env.DATABASE_SCHEMA_SYNC?.trim();
if (volumeMode !== "new" && volumeMode !== "external") {
  errors.push("AO_POSTGRES_VOLUME_MODE must be exactly 'new' or 'external'");
}
if (expectedVolumeMode && volumeMode !== expectedVolumeMode) {
  errors.push(
    `AO_POSTGRES_VOLUME_MODE must be '${expectedVolumeMode}' for this command; the env file contains '${volumeMode ?? ""}'`,
  );
}
if (schemaSync !== "0" && schemaSync !== "1") {
  errors.push("DATABASE_SCHEMA_SYNC must be exactly 0 or 1");
}
if (deployMode === "shared" && schemaSync !== "0") {
  errors.push("shared production mode requires DATABASE_SCHEMA_SYNC=0; apply only the exact reviewed SQL artifact");
}
if (schemaSync === "0") {
  warnings.push("DATABASE_SCHEMA_SYNC=0: schema changes will not run on web startup; generate/review a Prisma SQL diff, apply that exact approved SQL transactionally, then verify an empty diff");
}
if (volumeMode === "new" && hasValue("AO_EXISTING_POSTGRES_VOLUME")) {
  errors.push("AO_EXISTING_POSTGRES_VOLUME is set while AO_POSTGRES_VOLUME_MODE=new; remove it or use the explicit external-volume workflow");
}
if (volumeMode === "external") {
  requireValue("AO_EXISTING_POSTGRES_VOLUME", "exact existing Docker volume name is required for external reuse");
  const volumeName = env.AO_EXISTING_POSTGRES_VOLUME?.trim();
  if (validValue("AO_EXISTING_POSTGRES_VOLUME") && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(volumeName)) {
    errors.push("AO_EXISTING_POSTGRES_VOLUME contains characters Docker volume names do not support");
  }
  if (schemaSync !== "0") {
    errors.push("external PostgreSQL volume rehearsal requires DATABASE_SCHEMA_SYNC=0; apply only an exact reviewed SQL artifact after backup");
  }
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
