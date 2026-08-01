import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/ops/runtime-config", () => ({
  applyRuntimeConfigToEnv: vi.fn(),
  getRuntimeConfigState: vi.fn(),
  saveRuntimeConfig: vi.fn(),
}));

vi.mock("@/server/ops/infra-status", () => ({
  getInfraStatus: vi.fn(),
}));

vi.mock("@/server/em/clients/neo4j", () => ({
  closeDriver: vi.fn(),
}));

describe("PATCH /api/system/env-config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("returns 403 before parsing the request body in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { PATCH } = await import("./route");
    const r = await PATCH(new Request("http://localhost/api/system/env-config", {
      method: "PATCH",
      body: "{",
    }));

    expect(r.status).toBe(403);
    await expect(r.json()).resolves.toEqual({ ok: false, error: "SYSTEM_CONFIG_WRITE_DISABLED" });
  });

  it("stays disabled when only the production feature flag is enabled", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AO_SYSTEM_CONFIG_WRITE_ENABLED", "1");
    const { PATCH } = await import("./route");
    const r = await PATCH(new Request("http://localhost/api/system/env-config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: { AI_MODEL: "gpt-test" } }),
    }));

    expect(r.status).toBe(403);
    await expect(r.json()).resolves.toEqual({ ok: false, error: "SYSTEM_CONFIG_WRITE_DISABLED" });
  });
});
