import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFindMany = vi.fn();
const mockUpsert = vi.fn();
const mockDelete = vi.fn();

vi.mock("@/server/db", () => ({
  prisma: {
    runtimeConfig: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
      upsert: (...args: unknown[]) => mockUpsert(...args),
      delete: (...args: unknown[]) => mockDelete(...args),
    },
  },
}));

describe("runtime config production safety", () => {
  beforeEach(() => {
    mockFindMany.mockReset();
    mockUpsert.mockReset();
    mockDelete.mockReset();
    mockFindMany.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("classifies access keys as secret, read-only, and fully redacted", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MINIO_ACCESS_KEY", "minio-access-must-not-leak");
    const { getRuntimeConfigState } = await import("./runtime-config");

    const state = await getRuntimeConfigState();
    const field = state.fields.find((item) => item.key === "MINIO_ACCESS_KEY");

    expect(field).toMatchObject({
      secret: true,
      editable: false,
      fileValue: null,
      envValue: null,
      overrideValue: null,
      effectiveValue: null,
      displayValue: "••••••••",
    });
    expect(JSON.stringify(field)).not.toContain("minio-access-must-not-leak");
  });

  it("marks build-time browser configuration as read-only", async () => {
    const { getRuntimeConfigDefinitions, isDeploymentOwnedConfigKey } = await import("./runtime-config");
    const definitions = await getRuntimeConfigDefinitions();
    const field = definitions.find((item) => item.key === "NEXT_PUBLIC_INNGEST_URL");

    expect(field).toMatchObject({ editable: false, restartRequired: true });
    expect(isDeploymentOwnedConfigKey("COMPOSE_PROJECT_NAME")).toBe(true);
    expect(isDeploymentOwnedConfigKey("AO_IMAGE")).toBe(true);
  });

  it("does not apply persisted runtime overrides to the production process", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AI_MODEL", "boot-time-model");
    mockFindMany.mockResolvedValue([{ key: "AI_MODEL", value: "stale-runtime-model" }]);
    const { applyRuntimeConfigToEnv, getRuntimeConfigState } = await import("./runtime-config");

    await applyRuntimeConfigToEnv();
    const state = await getRuntimeConfigState();
    const field = state.fields.find((item) => item.key === "AI_MODEL");

    expect(process.env.AI_MODEL).toBe("boot-time-model");
    expect(mockFindMany).not.toHaveBeenCalled();
    expect(field).toMatchObject({
      source: "env",
      fileValue: null,
      hasOverride: false,
      overrideValue: null,
      effectiveValue: "boot-time-model",
    });
  });

  it("rejects direct save calls in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { saveRuntimeConfig } = await import("./runtime-config");

    await expect(saveRuntimeConfig({ AI_MODEL: "new-model" })).rejects.toThrow("SYSTEM_CONFIG_WRITE_DISABLED");
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
