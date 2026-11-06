import { afterEach, describe, expect, it, vi } from "vitest";
import { assertProductionRuntimeEnv, checkEnv } from "./env-check";

describe("env-check production preflight", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails production when Inngest dev keys are still configured", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "postgresql://ao:pw@localhost:5433/ao");
    vi.stubEnv("INNGEST_BASE_URL", "http://inngest:8288");
    vi.stubEnv("INNGEST_EVENT_KEY", "dev");
    vi.stubEnv("INNGEST_SIGNING_KEY", "dev");
    vi.stubEnv("INNGEST_SERVE_ORIGIN", "http://ao:3002");
    vi.stubEnv("RAAS_POSTGRES_URL", "postgresql://raas:pw@raas-db:5432/raas");
    vi.stubEnv("MINIO_ENDPOINT", "minio");
    vi.stubEnv("MINIO_ACCESS_KEY", "minio-access");
    vi.stubEnv("MINIO_SECRET_KEY", "minio-secret");
    vi.stubEnv("ROBOHIRE_API_KEY", "rh_live");
    vi.stubEnv("ALLMETA_BASE_URL", "http://allmeta:3500");
    vi.stubEnv("ALLMETA_API_KEY", "allmeta-token");
    vi.stubEnv("AI_API_KEY", "ai-token");

    const result = checkEnv();

    expect(result.ok).toBe(false);
    expect(() => assertProductionRuntimeEnv(result)).toThrow(/INNGEST_EVENT_KEY/);
  });

  it("passes production when RAAS-v1 runtime dependencies are present", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "postgresql://ao:pw@localhost:5433/ao");
    vi.stubEnv("INNGEST_BASE_URL", "http://inngest:8288");
    vi.stubEnv("INNGEST_EVENT_KEY", "evt_live");
    vi.stubEnv("INNGEST_SIGNING_KEY", "sign_live");
    vi.stubEnv("INNGEST_SERVE_ORIGIN", "http://ao:3002");
    vi.stubEnv("RAAS_PG_URL", "postgresql://raas:pw@raas-db:5432/raas");
    vi.stubEnv("MINIO_ENDPOINT", "minio");
    vi.stubEnv("MINIO_ACCESS_KEY", "minio-access");
    vi.stubEnv("MINIO_SECRET_KEY", "minio-secret");
    vi.stubEnv("ROBOHIRE_API_KEY", "rh_live");
    vi.stubEnv("ALLMETA_BASE_URL", "http://allmeta:3500");
    vi.stubEnv("ALLMETA_API_KEY", "allmeta-token");
    vi.stubEnv("OPENAI_API_KEY", "sk-live");

    const result = checkEnv();

    expect(result.ok).toBe(true);
    expect(() => assertProductionRuntimeEnv(result)).not.toThrow();
  });
});
