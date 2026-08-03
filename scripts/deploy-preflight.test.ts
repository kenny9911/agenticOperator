import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = process.cwd();
const script = join(repoRoot, "scripts", "deploy-preflight.mjs");
const tempDirs: string[] = [];

const validSharedEnv: Record<string, string> = {
  DEPLOY_MODE: "shared",
  COMPOSE_PROFILES: "",
  COMPOSE_PROJECT_NAME: "ao-v2",
  AO_PUBLIC_ORIGIN: "http://10.0.0.10:3002",
  INNGEST_PUBLIC_ORIGIN: "http://10.0.0.10:8288",
  AO_POSTGRES_USER: "ao",
  AO_POSTGRES_PASSWORD: "safe-test-password",
  AO_POSTGRES_DB: "ao",
  DATABASE_URL: "postgresql://ao:safe-test-password@ao-postgres:5432/ao",
  DATABASE_SCHEMA_SYNC: "0",
  AO_POSTGRES_VOLUME_MODE: "new",
  INNGEST_EVENT_KEY: "evt_test_live",
  INNGEST_SIGNING_KEY: "sign_test_live",
  INNGEST_BASE_URL: "http://raas-inngest:8288",
  INNGEST_SERVE_ORIGIN: "http://ao-v2-app:3002",
  RAAS_SHARED_NETWORK: "raas-production_default",
  AO_SHARED_NETWORK_ALIAS: "ao-v2-app",
  ALLMETA_BASE_URL: "http://allmeta.internal:3500",
  ALLMETA_API_KEY: "allmeta-test-key",
  ROBOHIRE_API_BASE_URL: "https://api.gohire.top",
  ROBOHIRE_API_KEY: "robohire-test-key",
  DOCUMENT_CONVERTER_URL: "http://gotenberg:3000",
  DOCUMENT_CONVERTER_TIMEOUT_MS: "130000",
  DOCUMENT_CONVERTER_MAX_INPUT_BYTES: "10485760",
  DOCUMENT_CONVERTER_MAX_OUTPUT_BYTES: "10485760",
  GOTENBERG_IMAGE: "gotenberg/gotenberg:8.34.0-libreoffice",
  GOTENBERG_API_TIMEOUT: "120s",
  GOTENBERG_API_BODY_LIMIT: "12MB",
  GOTENBERG_MAX_QUEUE_SIZE: "8",
  GOTENBERG_CPUS: "1.0",
  GOTENBERG_MEMORY_LIMIT: "1G",
  GOTENBERG_PIDS_LIMIT: "256",
  RAAS_POSTGRES_URL: "postgresql://raas:pw@raas-postgres:5432/raas",
  MINIO_ENDPOINT: "minio.internal",
  MINIO_ACCESS_KEY: "minio-test-key",
  MINIO_SECRET_KEY: "minio-test-secret",
  AGENT_EXECUTION_API_KEY: "execution-test-key",
  AI_BASE_URL: "https://ai.internal/v1",
  AI_API_KEY: "ai-test-key",
  AI_MODEL: "test-model",
  FACTORY_ENABLED: "0",
  NEXT_PUBLIC_FACTORY_ENABLED: "0",
  STUB_AGENTS: "0",
  RULE_CHECK_BYPASS: "false",
  AO_ENABLE_UNSAFE_DEV_ROUTES: "0",
};

function runPreflight(
  overrides: Record<string, string> = {},
  processOverrides: Record<string, string> = {},
  args: string[] = [],
) {
  const dir = mkdtempSync(join(tmpdir(), "ao-deploy-preflight-"));
  tempDirs.push(dir);
  const envPath = join(dir, ".env.deploy");
  const values = { ...validSharedEnv, ...overrides };
  writeFileSync(envPath, Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n"));
  return spawnSync(process.execPath, [script, "--env-file", envPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", ...processOverrides },
  });
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("deploy-preflight explicit deployment modes", () => {
  it("accepts the shared production topology with no compose profile", () => {
    const result = runPreflight();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("[deploy-check] OK");
  });

  it("treats the env file as authoritative over exported shell variables", () => {
    const result = runPreflight({}, {
      COMPOSE_PROJECT_NAME: "agentic-operator",
      DATABASE_SCHEMA_SYNC: "1",
      DEPLOY_MODE: "bundled",
      COMPOSE_PROFILES: "bundled-inngest",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("[deploy-check] OK");
  });

  it("rejects a missing or legacy/default compose project name", () => {
    const missing = runPreflight({ COMPOSE_PROJECT_NAME: "" });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("COMPOSE_PROJECT_NAME");

    const legacy = runPreflight({ COMPOSE_PROJECT_NAME: "agentic-operator" });
    expect(legacy.status).toBe(1);
    expect(legacy.stderr).toContain("new deployment generation");
  });

  it("rejects enabling bundled-inngest in shared mode", () => {
    const result = runPreflight({ COMPOSE_PROFILES: "bundled-inngest" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("shared mode requires COMPOSE_PROFILES to be empty");
  });

  it("rejects a converter URL outside the private Compose service", () => {
    const publicUrl = runPreflight({
      DOCUMENT_CONVERTER_URL: "https://converter.example.test",
    });
    expect(publicUrl.status).toBe(1);
    expect(publicUrl.stderr).toContain("must be exactly http://gotenberg:3000");

    const pathUrl = runPreflight({
      DOCUMENT_CONVERTER_URL: "http://gotenberg:3000/forms/libreoffice/convert",
    });
    expect(pathUrl.status).toBe(1);
    expect(pathUrl.stderr).toContain("must be an origin only");
  });

  it("rejects floating or non-LibreOffice Gotenberg images", () => {
    const floating = runPreflight({ GOTENBERG_IMAGE: "gotenberg/gotenberg:8" });
    expect(floating.status).toBe(1);
    expect(floating.stderr).toContain("8.34.0-libreoffice");

    const chromiumOnly = runPreflight({ GOTENBERG_IMAGE: "gotenberg/gotenberg:8.34.0" });
    expect(chromiumOnly.status).toBe(1);
    expect(chromiumOnly.stderr).toContain("8.34.0-libreoffice");

    const lookalike = runPreflight({
      GOTENBERG_IMAGE: "evil.example/anything:8.34.0-libreoffice",
    });
    expect(lookalike.status).toBe(1);
    expect(lookalike.stderr).toContain("approved official image");
  });

  it("rejects invalid converter size and timeout limits", () => {
    const result = runPreflight({
      DOCUMENT_CONVERTER_TIMEOUT_MS: "0",
      DOCUMENT_CONVERTER_MAX_INPUT_BYTES: "ten-megabytes",
      DOCUMENT_CONVERTER_MAX_OUTPUT_BYTES: "-1",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DOCUMENT_CONVERTER_TIMEOUT_MS must be a positive integer");
    expect(result.stderr).toContain("DOCUMENT_CONVERTER_MAX_INPUT_BYTES must be a positive integer");
    expect(result.stderr).toContain("DOCUMENT_CONVERTER_MAX_OUTPUT_BYTES must be a positive integer");
  });

  it("rejects unbounded or internally inconsistent Gotenberg resource limits", () => {
    const result = runPreflight({
      DOCUMENT_CONVERTER_TIMEOUT_MS: "120000",
      DOCUMENT_CONVERTER_MAX_INPUT_BYTES: "12000000",
      GOTENBERG_API_TIMEOUT: "120s",
      GOTENBERG_API_BODY_LIMIT: "12MB",
      GOTENBERG_MAX_QUEUE_SIZE: "0",
      GOTENBERG_CPUS: "0",
      GOTENBERG_MEMORY_LIMIT: "0G",
      GOTENBERG_PIDS_LIMIT: "-1",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be greater than GOTENBERG_API_TIMEOUT");
    expect(result.stderr).toContain("multipart overhead");
    expect(result.stderr).toContain("GOTENBERG_MAX_QUEUE_SIZE must be a positive integer");
    expect(result.stderr).toContain("GOTENBERG_CPUS must be a positive number");
    expect(result.stderr).toContain("GOTENBERG_MEMORY_LIMIT must be a positive Docker size");
    expect(result.stderr).toContain("GOTENBERG_PIDS_LIMIT must be a positive integer");
  });

  it("rejects a file whose mode differs from the command contract", () => {
    const result = runPreflight({}, {}, ["--expect-mode", "bundled"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be 'bundled' for this command");
  });

  it("rejects a shared callback hostname that differs from its network alias", () => {
    const result = runPreflight({ INNGEST_SERVE_ORIGIN: "http://wrong-app:3002" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must exactly match AO_SHARED_NETWORK_ALIAS");
  });

  it("rejects automatic schema mutation in shared production mode", () => {
    const result = runPreflight({ DATABASE_SCHEMA_SYNC: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("shared production mode requires DATABASE_SCHEMA_SYNC=0");
  });

  it("accepts the explicit isolated bundled topology", () => {
    const result = runPreflight({
      DEPLOY_MODE: "bundled",
      COMPOSE_PROFILES: "bundled-inngest",
      INNGEST_BASE_URL: "http://inngest:8288",
      INNGEST_SERVE_ORIGIN: "http://app:3002",
      RAAS_SHARED_NETWORK: "",
      AO_SHARED_NETWORK_ALIAS: "",
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects shared-only network values in bundled mode", () => {
    const result = runPreflight({
      DEPLOY_MODE: "bundled",
      COMPOSE_PROFILES: "bundled-inngest",
      INNGEST_BASE_URL: "http://inngest:8288",
      INNGEST_SERVE_ORIGIN: "http://app:3002",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must not carry shared-only");
  });
});

describe("deploy-preflight PostgreSQL volume guard", () => {
  it("requires an exact existing volume name for external reuse", () => {
    const result = runPreflight({ AO_POSTGRES_VOLUME_MODE: "external" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("AO_EXISTING_POSTGRES_VOLUME");
  });

  it("accepts external reuse only with schema auto-sync disabled", () => {
    const result = runPreflight({
      AO_POSTGRES_VOLUME_MODE: "external",
      AO_EXISTING_POSTGRES_VOLUME: "ao-postgres_ao-pgdata",
      DATABASE_SCHEMA_SYNC: "0",
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects automatic schema mutation of an external volume", () => {
    const result = runPreflight({
      AO_POSTGRES_VOLUME_MODE: "external",
      AO_EXISTING_POSTGRES_VOLUME: "ao-postgres_ao-pgdata",
      DATABASE_SCHEMA_SYNC: "1",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requires DATABASE_SCHEMA_SYNC=0");
  });

  it("rejects a file whose volume mode differs from the command contract", () => {
    const result = runPreflight({}, {}, ["--expect-volume-mode", "external"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be 'external' for this command");
  });
});
