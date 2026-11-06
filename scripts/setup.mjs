#!/usr/bin/env node
// Partner-facing one-shot deployment setup.
//
// Goal: a fresh `git clone` + `npm install` + `npm run setup` leaves the app
// ready for `npm run build && npm run start` (or `npm run dev`). No manual
// mkdir, no surprise prisma config errors, no "where do I put DATABASE_URL".
//
// Steps:
//   1. Verify Node ≥ 22 (package.json engines.node).
//   2. Verify .env.local exists; if not, copy from .env.example with a banner.
//   3. Load .env.local into process.env via dotenv.
//   4. Run env preflight (warn on placeholders, fail on missing required).
//   5. Ensure ./data and ./logs directories exist (agent-logger + migration src).
//   6. Provision local Postgres (Docker), then `prisma generate` + `db push`.
//
// Idempotent — safe to re-run after editing .env.local.

import { existsSync, copyFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const dim = "\x1b[2m";
const reset = "\x1b[0m";
const red = "\x1b[31m";
const yellow = "\x1b[33m";
const green = "\x1b[32m";
const cyan = "\x1b[36m";

const log = (m) => console.log(`${cyan}[setup]${reset} ${m}`);
const warn = (m) => console.warn(`${yellow}[setup]${reset} ${m}`);
const fail = (m) => {
  console.error(`${red}[setup] ✗ ${m}${reset}`);
  process.exit(1);
};

// 1. Node version check
const major = Number(process.versions.node.split(".")[0]);
if (!Number.isFinite(major) || major < 22) {
  fail(`Node 22+ required (you have ${process.versions.node}). nvm install 22.`);
}
log(`Node ${process.versions.node} ✓`);

// 2. .env.local scaffold
const envLocal = resolve(ROOT, ".env.local");
const envExample = resolve(ROOT, ".env.example");
if (!existsSync(envLocal)) {
  if (!existsSync(envExample)) {
    fail(".env.example missing — can't scaffold .env.local. Re-clone the repo?");
  }
  copyFileSync(envExample, envLocal);
  warn(`Created .env.local from .env.example.`);
  warn(`  → ${dim}edit it with your real keys, then re-run \`npm run setup\`.${reset}`);
  warn(`  → continuing anyway; placeholder values will show as warnings below.`);
}

// 3. Load .env.local
try {
  require("dotenv").config({ path: envLocal });
} catch (e) {
  fail(
    `Couldn't load dotenv — did \`npm install\` run? Error: ${e.message}`,
  );
}

// 4. Env preflight (uses the same checker server/init.ts runs at boot)
log(`Checking env vars…`);
try {
  execSync("npx tsx scripts/check-env.ts", {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
} catch {
  // check-env.ts exits 1 on missing required vars. Don't block setup —
  // partner can fix .env.local then re-run setup. Prisma still works if
  // DATABASE_URL is set, which is the only REQUIRED var.
  warn(`env preflight reported issues; fix .env.local and re-run setup.`);
}

// 5. data/ + logs/ directories
for (const dir of ["data", "logs"]) {
  const p = resolve(ROOT, dir);
  if (!existsSync(p)) {
    mkdirSync(p, { recursive: true });
    log(`Created ${dir}/`);
  }
}

// 6. Local Postgres (Docker) — best-effort, then prisma generate + db push.
const usingPostgres = (process.env.DATABASE_URL ?? "").startsWith("postgres");
if (usingPostgres) {
  try {
    log(`Starting local Postgres (docker-compose.postgres.yml)…`);
    execSync("docker compose -f docker-compose.postgres.yml up -d --wait", {
      cwd: ROOT,
      stdio: "inherit",
    });
  } catch (e) {
    warn(`Couldn't start Postgres via Docker (${e.message}).`);
    warn(`  → start Docker + run \`npm run pg:up\`, or point DATABASE_URL elsewhere.`);
  }
}
log(`Running prisma generate + db push…`);
try {
  execSync("npx prisma generate", {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  execSync("npx prisma db push --accept-data-loss", {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
} catch (e) {
  fail(
    `Prisma setup failed: ${e.message}\n` +
      `  → if you see "Cannot find module 'dotenv/config'", run \`npm install\` first.\n` +
      `  → if you see a Postgres connection error, run \`npm run pg:up\` (port 5433) and check DATABASE_URL.`,
  );
}

console.log(`\n${green}✓ Setup complete.${reset}`);
console.log(`${dim}Next: \`npm run dev\` (or \`npm run build && npm run start\`).${reset}\n`);
