import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SystemConfigResponse } from "@/app/api/system/config/route";
import type { SystemEnvConfigResponse } from "@/app/api/system/env-config/route";

const { mockFetchJson, mockT } = vi.hoisted(() => ({
  mockFetchJson: vi.fn(),
  mockT: (key: string) => key,
}));

vi.mock("@/lib/api/client", () => ({ fetchJson: mockFetchJson }));
vi.mock("@/lib/i18n", () => ({
  useApp: () => ({ t: mockT }),
}));
vi.mock("@/components/shared/InngestAppRegistrationControls", () => ({
  DomainInngestAppManager: () => null,
  MainInngestAppRegistration: () => null,
}));
vi.mock("@/components/settings/ProcessControlPanel", () => ({
  ProcessControlPanel: () => null,
}));

import { EnvironmentConfigContent } from "./EnvironmentConfigContent";

const generatedAt = "2026-08-01T00:00:00.000Z";

const envConfig = {
  runtimeConfig: {
    fields: [{
      key: "AI_MODEL",
      label: "AI model",
      section: "ai",
      sectionLabel: "AI gateway",
      description: "Model selected at process startup.",
      editable: true,
      restartRequired: false,
      secret: false,
      envValue: "boot-model",
      overrideValue: null,
      effectiveValue: "boot-model",
      displayValue: "boot-model",
      source: "env",
      hasEnvValue: true,
      hasOverride: false,
      hasEffectiveValue: true,
    }],
    writableEnvFile: ".env.local",
    updatedAt: generatedAt,
  },
  infra: {
    subsystems: [],
    inngest: { serveEndpointUrl: "http://app:3002/api/inngest" },
  },
  writePolicy: { enabled: false, reason: "production_auth_required" },
  generatedAt,
} as unknown as SystemEnvConfigResponse;

const systemConfig = {
  inngest: {
    url: "http://inngest:8288",
    sourceEnv: "INNGEST_BASE_URL",
    altEnvs: {},
    registeredFunctionCount: 0,
    runsLast24h: 0,
    healthy: true,
    appErrors: [],
    serveEndpointUrl: "http://app:3002/api/inngest",
    lastProbeAt: generatedAt,
  },
  eventEngine: {
    lastSyncAt: null,
    syncedEventCount: 0,
    staleSeconds: null,
    staleness: "never",
    lastError: null,
  },
  raas: {
    apiUrl: null,
    inngestUrl: "http://inngest:8288",
    inngestSharedWithLocal: true,
    apiHealthy: null,
  },
  runtimeConfig: envConfig.runtimeConfig,
  writePolicy: envConfig.writePolicy,
  generatedAt,
} satisfies SystemConfigResponse;

describe("EnvironmentConfigContent production read-only state", () => {
  afterEach(() => {
    cleanup();
    mockFetchJson.mockReset();
  });

  it("hides save controls and disables config inputs when writes are unavailable", async () => {
    mockFetchJson.mockImplementation((url: string) => Promise.resolve(
      url.endsWith("env-config") ? envConfig : systemConfig,
    ));

    render(<EnvironmentConfigContent />);

    const input = await screen.findByDisplayValue("boot-model");
    await waitFor(() => expect(mockFetchJson).toHaveBeenCalledTimes(2));

    expect((input as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("settings_env_write_disabled_hint")).toBeTruthy();
    expect(screen.queryByText("settings_env_save_target")).toBeNull();
    expect(screen.queryByRole("button", { name: "config_save" })).toBeNull();
  });
});
