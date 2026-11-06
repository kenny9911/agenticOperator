// lib/partner-pg/client.ts
//
// Connection pool to partner's Postgres at 192.168.1.103:5432/raas_db.
// Singleton — reuse across all agents and all Inngest steps.
//
// HMR-safe: in Next.js dev mode the module is re-evaluated on every file
// change, which would otherwise leak a new pg.Pool per HMR cycle. We
// stash the pool on globalThis under a guarded key so re-imports reuse
// the same pool (and only in dev — production keeps strict module-local
// state). Verified by the partner spec's acceptance criteria:
//   "SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE …
//    不持续增长"
//
// Per 2026-05-20 dual-write decision: AO writes directly to partner's
// Postgres, replacing the RAAS HTTP API. See:
//   docs/superpowers/specs/2026-05-20-ao-direct-dual-write-event-flow.md
//   docs/superpowers/plans/2026-05-20-ao-direct-dual-write.md

import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { currentLogger } from '@/lib/agent-logger';
import { logApiCall } from '@/lib/external-api-log';
import { isConnFailure, runWithMirrorFallback } from './mirror-fallback';

declare global {
  // eslint-disable-next-line no-var
  var __raasPgPool: Pool | undefined;
  // eslint-disable-next-line no-var
  var __raasMirrorPool: Pool | undefined;
}

let pool: Pool | null = globalThis.__raasPgPool ?? null;
let mirrorPool: Pool | null = globalThis.__raasMirrorPool ?? null;

// ── 开发态本地镜像兜底 ──────────────────────────────────────────────────
// partner-pg(同事远程库)连不上时,透明改用本地镜像库(只读/写都行)。
// 门控:配了 RAAS_MIRROR_PG_URL 且 RAAS_MIRROR_ENABLED ≠ '0' 才启用。
// 生产部署不配 RAAS_MIRROR_PG_URL → getMirrorPool() 恒为 null → 永不兜底,
// 行为与改造前完全一致(不影响 agent 任何逻辑)。
function getMirrorPool(): Pool | null {
  const url = process.env.RAAS_MIRROR_PG_URL?.trim();
  if (!url || process.env.RAAS_MIRROR_ENABLED === '0') return null;
  if (mirrorPool) return mirrorPool;
  mirrorPool = new Pool({
    connectionString: url,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  mirrorPool.on('error', (err) => reportPgFailure(err, { phase: 'idle', label: 'mirror-idle-error' }));
  try {
    const u = new URL(url);
    console.log(
      `[partner-pg] 本地镜像兜底已启用(开发态)· mirror=${u.host}${u.pathname} · ` +
        `partner 连不上时透明切到这里。生产不配此 env 即关闭。`,
    );
  } catch {
    /* url parse fail — let pg surface it on first use */
  }
  if (process.env.NODE_ENV !== 'production') globalThis.__raasMirrorPool = mirrorPool;
  return mirrorPool;
}

// First non-empty line of the SQL (collapsed) — used as the apiCall label so
// "pg.SELECT candidate_id FROM candidate WHERE …" shows up grouped in logs.
function sqlLabel(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  const verb = oneLine.split(' ')[0]?.toUpperCase() || 'SQL';
  // Show first SQL keyword + first 60 chars
  return `pg.${verb} ${oneLine.slice(0, 60)}`;
}

// ──────────────────────────────────────────────────────────────────────
// Failure reporting
//
// When partner Postgres is unreachable (host down, port firewalled, pool
// timeout) the bare pg-pool stack trace that bubbles up to Inngest's
// terminal logger lacks the context that makes the problem actionable:
// which host:port is dead, which JR / candidate we were processing,
// which agent is calling us. `reportPgFailure` consolidates that view.
// ──────────────────────────────────────────────────────────────────────

let cachedHostPort: string | null = null;
function pgHostPort(): string {
  if (cachedHostPort) return cachedHostPort;
  const url = readPgUrl();
  if (!url) return '?';
  try {
    const u = new URL(url);
    cachedHostPort = `${u.hostname}:${u.port || '5432'}`;
  } catch {
    cachedHostPort = '?';
  }
  return cachedHostPort;
}

/**
 * Map common pg / node-net errors to a one-word kind + human-readable hint
 * so the terminal banner reads cleanly without grep-ing stack traces.
 */
function classifyPgError(err: unknown): { kind: string; hint: string } {
  const e = err as { code?: string; message?: string };
  const code = e?.code ?? '';
  const msg = e?.message ?? String(err);
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/i.test(msg))
    return { kind: 'ECONNREFUSED', hint: 'Postgres 拒绝连接 — 服务可能未启动或端口未监听' };
  if (code === 'ETIMEDOUT' || /timeout/i.test(msg))
    return { kind: 'ETIMEDOUT', hint: 'TCP 连接超时 — 网络不通 / 防火墙拦截 / RAAS 主机不可达' };
  if (code === 'ENOTFOUND' || /ENOTFOUND/i.test(msg))
    return { kind: 'ENOTFOUND', hint: 'DNS 解析失败 — RAAS_PG_URL host 拼错或域名不存在' };
  if (code === 'ECONNRESET' || /Connection terminated/i.test(msg))
    return { kind: 'ECONNRESET', hint: 'Postgres 提前断开 — 服务重启 / 连接被 server 主动 kill' };
  if (code === '28P01' || /password authentication failed/i.test(msg))
    return { kind: 'AUTH', hint: 'Postgres 拒绝鉴权 — RAAS_PG_URL 用户名/密码错' };
  if (code === '3D000' || /database .* does not exist/i.test(msg))
    return { kind: 'NODB', hint: 'database 不存在 — RAAS_PG_URL 的 db 名错了' };
  if (/Connection terminated due to connection timeout/i.test(msg))
    return { kind: 'POOL_ACQUIRE_TIMEOUT', hint: 'pg-pool 拿不到连接 — server 不可达 (5s 超时)' };
  return { kind: code || 'PgError', hint: msg.slice(0, 200) };
}

type FailureCtx = {
  phase: 'acquire' | 'query' | 'tx-query' | 'tx-begin' | 'idle';
  label: string;
  durationMs?: number;
  sql?: string;
  params?: unknown[];
};

/**
 * Emit one consolidated banner per partner-pg failure:
 *   - terminal console.error so the dev sees it without opening log files
 *   - structured apiCall into the per-agent file log (anchors carry jr/candidate)
 * Both paths share the same classification + host:port + agent context.
 */
function reportPgFailure(err: unknown, ctx: FailureCtx): void {
  const { kind, hint } = classifyPgError(err);
  const host = pgHostPort();
  const logger = currentLogger();
  const dur = ctx.durationMs != null ? `${ctx.durationMs}ms` : '?';
  const sqlPreview = ctx.sql ? ` sql="${ctx.sql.replace(/\s+/g, ' ').slice(0, 80)}…"` : '';
  // Console banner: 3 lines, scannable.
  //   ✗ partner-pg <phase> <label> host=H:P dur=Xms kind=ETIMEDOUT
  //     hint: 中文一句话
  //     sql: "SELECT …"   (only on query/tx-query phases)
  // eslint-disable-next-line no-console
  console.error(
    `\x1b[31m[partner-pg] ✗ ${ctx.phase} ${ctx.label} · host=${host} dur=${dur} kind=${kind}\x1b[0m\n` +
      `  hint: ${hint}` +
      (sqlPreview ? `\n  ${sqlPreview.trim()}` : ''),
  );
  // Structured file log entry — same classification, plus anchors via logger ctx.
  logger?.event('pg.failure', {
    phase: ctx.phase,
    label: ctx.label,
    host,
    kind,
    hint,
    duration_ms: ctx.durationMs,
    sql: ctx.sql ? ctx.sql.slice(0, 800) : undefined,
    params: ctx.params,
    error: (err as Error)?.message,
  });
}

async function loggedQuery<T extends QueryResultRow = QueryResultRow>(
  exec: (text: string, params?: unknown[]) => Promise<QueryResult<T>>,
  text: string,
  params: unknown[] | undefined,
  inTx: boolean,
): Promise<QueryResult<T>> {
  // 2026-05-26: 独立 sink (logs/partner-pg-<date>.log + terminal echo) 必落,
  // 绕过 AsyncLocalStorage — Inngest step.run 内部 currentLogger() 可能返 null
  // 导致 SQL in/out 静默丢失 (跟 RoboHire 09:19 那条事故同一原因).
  // agent file logger 路径保留(ALS context 在的话双写一份给 agent 自己的 log).
  const logger = currentLogger();
  const start = Date.now();
  const label = sqlLabel(text);
  const sqlPreview = text.length > 800 ? text.slice(0, 800) + '…' : text;
  const url = inTx ? 'partner-pg://tx-query' : 'partner-pg://query';
  try {
    const r = await exec(text, params);
    const durationMs = Date.now() - start;
    logApiCall({
      category: 'partner-pg',
      label,
      url,
      method: 'POST',
      status: 200,
      duration_ms: durationMs,
      request: { sql: sqlPreview, params, in_tx: inTx },
      response: { rowCount: r.rowCount },
    });
    logger?.apiCall(label, {
      url,
      method: 'POST',
      request: { sql: sqlPreview, params, in_tx: inTx },
      status: 200,
      durationMs,
      response: { rowCount: r.rowCount },
    });
    return r;
  } catch (err) {
    const durationMs = Date.now() - start;
    logApiCall({
      category: 'partner-pg',
      label,
      url,
      method: 'POST',
      duration_ms: durationMs,
      request: { sql: sqlPreview, params, in_tx: inTx },
      error: (err as Error).message,
    });
    logger?.apiCall(label, {
      url,
      method: 'POST',
      request: { sql: sqlPreview, params, in_tx: inTx },
      durationMs,
      error: (err as Error).message,
    });
    reportPgFailure(err, {
      phase: inTx ? 'tx-query' : 'query',
      label,
      durationMs,
      sql: text,
      params,
    });
    throw err;
  }
}

function readPgUrl(): string | null {
  // RAAS_PG_URL is the partner-contract canonical name (per 2026-05-21
  // recruiting-jobs spec). RAAS_POSTGRES_URL is our legacy name, kept as
  // fallback so existing deployments don't have to flip env in lock-step.
  return (
    process.env.RAAS_PG_URL?.trim() ||
    process.env.RAAS_POSTGRES_URL?.trim() ||
    null
  );
}

function getPool(): Pool {
  if (pool) return pool;
  const url = readPgUrl();
  if (!url) {
    throw new Error('[partner-pg] RAAS_PG_URL / RAAS_POSTGRES_URL not set in env');
  }
  pool = new Pool({
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
    // Pin the session timezone to UTC at connection startup (partner-pg 980a9dd).
    //
    // raas Postgres (prod) runs PGTZ=Asia/Shanghai and its time columns are
    // `timestamp without time zone`. Our writes use raw `NOW()` (see
    // candidates.ts), a timestamptz cast into the tz-less column using the
    // *session* timezone. Inheriting Asia/Shanghai stores Beijing wall-clock
    // (e.g. 17:38) into a column everyone else — raas Prisma + the frontend —
    // treats as UTC, producing a +8h display offset (17:38 → next-day 01:38).
    // Applied via the startup `options` param so it takes effect before the
    // first query (race-free, unlike a 'connect' SET TIME ZONE handler).
    options: '-c timezone=UTC',
  });
  pool.on('error', (err) => {
    reportPgFailure(err, { phase: 'idle', label: 'idle-client-error' });
  });
  // ★ Print effective host:port on first pool creation so "I changed the env
  //   but the app is still connecting to the old IP" is diagnosable in one
  //   glance. pg.Pool caches the connectionString — it's NOT re-read on
  //   subsequent calls — so any host change requires a full process restart.
  //   This log is the canary that says "this is the host the pool actually
  //   bound to". If it doesn't match your .env.local, you forgot to restart.
  try {
    const parsed = new URL(url);
    const sourceVar = process.env.RAAS_PG_URL?.trim()
      ? 'RAAS_PG_URL'
      : 'RAAS_POSTGRES_URL';
    console.log(
      `[partner-pg] pool created · host=${parsed.host} · db=${parsed.pathname.replace(/^\//, '')} · source=${sourceVar} · ` +
        `pid=${process.pid}. Restart the Next.js process if you change this env.`,
    );
  } catch {
    // URL parse failed — connectionString format is off, but let pg report
    // the real error on first query rather than hiding it here.
  }
  if (process.env.NODE_ENV !== 'production') {
    // Survive Next.js HMR re-imports — see header comment.
    globalThis.__raasPgPool = pool;
  }
  return pool;
}

export function isPartnerPgConfigured(): boolean {
  return !!readPgUrl();
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  const p = getPool();
  const mirror = getMirrorPool();
  return runWithMirrorFallback<QueryResult<T>>(
    () => loggedQuery<T>((t, ps) => p.query<T>(t, ps as never), text, params, false),
    mirror
      ? () => {
          console.warn('[partner-pg] ✗ partner 不可达 → 本地镜像兜底(query · 开发态)');
          return loggedQuery<T>((t, ps) => mirror.query<T>(t, ps as never), text, params, false);
        }
      : null,
  );
}

/**
 * Run a callback inside a transaction. Rolls back on throw.
 *
 * The PoolClient passed to `fn` is proxied so that every `c.query(...)` call
 * inside the transaction body also flows through the per-agent logger.
 * BEGIN / COMMIT / ROLLBACK are logged as well so a single audit line per
 * step shows the full tx boundary.
 */
export async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  try {
    return await runTxOnPool(getPool(), fn);
  } catch (err) {
    const mirror = getMirrorPool();
    if (mirror && isConnFailure(err)) {
      console.warn('[partner-pg] ✗ partner 不可达 → 本地镜像兜底(事务 · 开发态)');
      return await runTxOnPool(mirror, fn);
    }
    throw err;
  }
}

/** 在给定 pool 上跑一个事务(BEGIN/COMMIT/ROLLBACK + c.query 代理打点)。
 *  withTx 先用 partner pool 跑;连不上(ECONNREFUSED 等)才换 mirror pool 重跑。 */
async function runTxOnPool<T>(targetPool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const acquireStart = Date.now();
  let c: PoolClient;
  try {
    c = await targetPool.connect();
  } catch (err) {
    reportPgFailure(err, {
      phase: 'acquire',
      label: 'pool.connect',
      durationMs: Date.now() - acquireStart,
    });
    throw err;
  }
  const txStart = Date.now();
  const logger = currentLogger();
  // Proxy the client so the body's c.query(...) gets the same telemetry as
  // the top-level pool query helper.
  const proxied = new Proxy(c, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return (text: string, params?: unknown[]) =>
          loggedQuery((t, ps) => target.query(t, ps as never), text, params, true);
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as PoolClient;
  try {
    await c.query('BEGIN');
    logger?.event('pg.tx.begin', { ms_since_acquire: Date.now() - txStart });
    const result = await fn(proxied);
    await c.query('COMMIT');
    logger?.event('pg.tx.commit', { duration_ms: Date.now() - txStart });
    return result;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    logger?.event('pg.tx.rollback', {
      duration_ms: Date.now() - txStart,
      error: (err as Error).message,
    });
    throw err;
  } finally {
    c.release();
  }
}

/** Close pool — used by tests + graceful shutdown. */
export async function close(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    if (process.env.NODE_ENV !== 'production') {
      globalThis.__raasPgPool = undefined;
    }
  }
}
