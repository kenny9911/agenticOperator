#!/usr/bin/env node
// Idempotent first-run setup for `npm run dev`.
//
// Goal: a fresh `git clone` + `npm install` + `npm run dev` boots the app,
// regardless of what's missing on the partner's machine.
//
// Steps (each one is no-op when already satisfied):
//   1. Create `.env.local` from `.env.example` if missing.
//   2. Provision the local Postgres (docker-compose.postgres.yml) and sync the
//      Prisma schema. Soft-fail if Docker is down so `next dev` still launches.
//   3. Best-effort start the Inngest dev container (soft-fail).
//   4. Best-effort start the Inngest archiver in the background (dedup-guarded,
//      soft-fail) so the durable mirror keeps filling while you develop.

import { existsSync, copyFileSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { execFileSync, execSync, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const log = (m) => console.log(`[bootstrap] ${m}`);
const warn = (m) => console.warn(`[bootstrap] ⚠ ${m}`);
const childEnv = {
  ...process.env,
  PATH: `${dirname(process.execPath)}:${process.env.PATH || ""}`,
};

// 1. .env.local
const envLocal = resolve(ROOT, ".env.local");
const envExample = resolve(ROOT, ".env.example");
if (!existsSync(envLocal)) {
  if (existsSync(envExample)) {
    copyFileSync(envExample, envLocal);
    log("created .env.local from .env.example — fill in API keys as needed");
  } else {
    warn(".env.example missing; cannot scaffold .env.local");
  }
}

// Load .env.local for bootstrap itself. Next/tsx load it later, but this script
// needs INNGEST_BASE_URL / INNGEST_SERVE_ORIGIN before it decides which helper
// processes to start.
if (existsSync(envLocal)) {
  try {
    const raw = readFileSync(envLocal, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
      if (!m || process.env[m[1]] !== undefined) continue;
      let v = m[2].trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      process.env[m[1]] = v;
    }
  } catch (e) {
    warn(`could not load .env.local for bootstrap: ${e.message}`);
  }
}

const dockerUp = (() => {
  try {
    execSync("docker info", { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// 2. Local Postgres + schema sync
let pgReady = false;
if (dockerUp) {
  try {
    log("starting local Postgres (docker-compose.postgres.yml)…");
    // --wait blocks until the healthcheck passes; idempotent when already up.
    execSync("docker compose -f docker-compose.postgres.yml up -d --wait", {
      cwd: ROOT,
      stdio: "inherit",
    });
    log("syncing Prisma schema (`prisma db push`)…");
    // No forced DATABASE_URL — prisma.config.ts loads .env.local (Postgres).
    execSync("npx prisma db push", { cwd: ROOT, stdio: "inherit" });
    pgReady = true;
  } catch (e) {
    warn(`Postgres provisioning failed: ${e.message}`);
    warn("app will boot but DB-backed routes will throw until Postgres is up.");
    warn("manual: `npm run pg:up && npx prisma db push`");
  }
} else {
  warn("Docker daemon unreachable — skipping Postgres provisioning.");
  warn("start Docker, then run `npm run pg:up && npx prisma db push`.");
}

// 3. Inngest event bus (soft-fail) — NATIVE inngest-cli only, NEVER Docker.
//    A Docker-hosted Inngest can't reach the host app at localhost:3002 to
//    complete SDK registration (agents fail to register with ECONNREFUSED),
//    and it also breaks RAAS partner LAN access. The local CLI runs on the
//    host and calls back to :3002 cleanly. Dedup-guarded + detached so a
//    repeated `npm run dev` reuses the already-running server.
const localInngestCli = resolve(ROOT, "node_modules/.bin/inngest-cli");
const hasLocalCli = existsSync(localInngestCli);
const localTsx = resolve(ROOT, "node_modules/.bin/tsx");
const hasLocalTsx = existsSync(localTsx);

const DEFAULT_INNGEST_BASE_URL = "http://localhost:8288";

function resolveInngestBaseUrl() {
  const candidates = [
    process.env.INNGEST_BASE_URL,
    process.env.INNGEST_DEV,
    process.env.INNGEST_LOCAL_URL,
    process.env.INNGEST_ADMIN_URL,
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return new URL(candidate).toString().replace(/\/$/, "");
    } catch {
      // INNGEST_DEV=1 is a common SDK flag, not a URL. Keep looking.
    }
  }
  return DEFAULT_INNGEST_BASE_URL;
}

const inngestBaseUrl = resolveInngestBaseUrl();

function isLocalHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function inngestReachable(baseUrl) {
  try {
    const url = new URL("/v1/events?limit=1", baseUrl).toString();
    execFileSync("curl", ["-fsS", "-m", "2", url], { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function hasRunningScript(script) {
  try {
    const stdout = execFileSync("ps", ["-axo", "stat=,command="], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .some((line) => {
        const match = /^(\S+)\s+(.+)$/.exec(line);
        if (!match) return false;
        const [, stat, command] = match;
        return !/[TZX]/.test(stat) && command.includes(ROOT) && command.includes(script);
      });
  } catch {
    return false;
  }
}

const inngestUrl = new URL(inngestBaseUrl);
const inngestPort = inngestUrl.port || (inngestUrl.protocol === "https:" ? "443" : "80");
const inngestIsLocal = isLocalHost(inngestUrl.hostname);

if (inngestReachable(inngestBaseUrl)) {
  log(`Inngest dev server reachable at ${inngestBaseUrl} — leaving it.`);
} else if (!hasLocalCli) {
  warn(`Inngest is not reachable at ${inngestBaseUrl}, and no local inngest-cli was found.`);
  warn("run `npm install`, then `npm run inngest:dev`");
  warn("UI will load; event stream / agent runs are inert until Inngest is up");
} else if (!inngestIsLocal) {
  warn(`configured Inngest (${inngestBaseUrl}) is not reachable; not starting a local CLI for a non-local URL.`);
  warn("fix INNGEST_BASE_URL or start the shared Inngest server.");
} else {
  try {
    mkdirSync(resolve(ROOT, "logs"), { recursive: true });
    const out = openSync(resolve(ROOT, "logs/inngest.log"), "a");
    const serveUrl = `${process.env.INNGEST_SERVE_ORIGIN || "http://localhost:3002"}/api/inngest`;
    const child = spawn(localInngestCli, ["dev", "--host", "0.0.0.0", "-p", inngestPort, "-u", serveUrl], {
      cwd: ROOT,
      detached: true,
      stdio: ["ignore", out, out],
      env: childEnv,
    });
    child.unref();
    log(`started native Inngest dev server at ${inngestBaseUrl} → logs/inngest.log (serve ${serveUrl})`);
  } catch (e) {
    warn(`could not start native Inngest: ${e.message}`);
    warn("manual: run `npm run inngest:dev` in another terminal");
  }
}

// 4. Inngest archiver (durable mirror) — background, dedup-guarded, soft-fail.
if (pgReady && process.env.ARCHIVE_ENABLED !== "0") {
  const alreadyRunning = hasRunningScript("scripts/inngest-archiver.ts");
  if (alreadyRunning) {
    log("archiver already running — leaving it.");
  } else {
    try {
      mkdirSync(resolve(ROOT, "logs"), { recursive: true });
      const out = openSync(resolve(ROOT, "logs/inngest-archiver.log"), "a");
      if (!hasLocalTsx) throw new Error("node_modules/.bin/tsx not found");
      const child = spawn(localTsx, ["--env-file=.env.local", "scripts/inngest-archiver.ts"], {
        cwd: ROOT,
        detached: true,
        stdio: ["ignore", out, out],
        env: childEnv,
      });
      child.unref();
      log("started Inngest archiver in background → logs/inngest-archiver.log");
    } catch (e) {
      warn(`could not start archiver: ${e.message}`);
      warn("manual: run `npm run archive` in another terminal");
    }
  }
} else if (!pgReady) {
  warn("skipping archiver (Postgres not ready). Start it later with `npm run archive`.");
}

// 5. Monitor sweeper (deterministic health/SLA/cost/error monitors) — background,
//    dedup-guarded, soft-fail. Off-Inngest; reads the archive, writes Notification.
if (pgReady && process.env.MONITOR_SWEEP !== "0") {
  const alreadyRunning = hasRunningScript("scripts/monitor-sweeper.ts");
  if (alreadyRunning) {
    log("monitor sweeper already running — leaving it.");
  } else {
    try {
      mkdirSync(resolve(ROOT, "logs"), { recursive: true });
      const out = openSync(resolve(ROOT, "logs/monitor-sweeper.log"), "a");
      if (!hasLocalTsx) throw new Error("node_modules/.bin/tsx not found");
      const child = spawn(localTsx, ["--env-file=.env.local", "scripts/monitor-sweeper.ts"], {
        cwd: ROOT,
        detached: true,
        stdio: ["ignore", out, out],
        env: childEnv,
      });
      child.unref();
      log("started monitor sweeper in background → logs/monitor-sweeper.log");
    } catch (e) {
      warn(`could not start monitor sweeper: ${e.message}`);
      warn("manual: run `npm run monitor:sweep` in another terminal");
    }
  }
} else if (!pgReady) {
  warn("skipping monitor sweeper (Postgres not ready). Start it later with `npm run monitor:sweep`.");
}

log("ready");
