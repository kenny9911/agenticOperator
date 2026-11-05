import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = process.cwd();
const wrapper = join(repoRoot, "scripts", "deploy-compose.sh");
const tempDirs: string[] = [];

function runWrapper(
  fileValues: Record<string, string>,
  exportedValues: Record<string, string> = {},
  wrapperOptions: string[] = [],
) {
  const dir = mkdtempSync(join(tmpdir(), "ao-deploy-compose-"));
  tempDirs.push(dir);
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  const fakeDocker = join(binDir, "docker");
  writeFileSync(
    fakeDocker,
    `#!/bin/sh
printf 'AO_ENV_FILE=%s\\n' "\${AO_ENV_FILE-}"
printf 'COMPOSE_PROJECT_NAME=%s\\n' "\${COMPOSE_PROJECT_NAME-}"
printf 'DATABASE_SCHEMA_SYNC=%s\\n' "\${DATABASE_SCHEMA_SYNC-}"
printf 'DEPLOY_MODE=%s\\n' "\${DEPLOY_MODE-}"
printf 'AO_POSTGRES_VOLUME_MODE=%s\\n' "\${AO_POSTGRES_VOLUME_MODE-}"
printf 'AO_EXISTING_POSTGRES_VOLUME=%s\\n' "\${AO_EXISTING_POSTGRES_VOLUME-}"
for arg in "$@"; do printf 'ARG=%s\\n' "$arg"; done
`,
  );
  chmodSync(fakeDocker, 0o755);

  const envPath = join(dir, ".env.deploy");
  writeFileSync(
    envPath,
    Object.entries(fileValues)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
  );

  return {
    envPath,
    result: spawnSync(
      "bash",
      [wrapper, "--env-file", envPath, ...wrapperOptions, "--", "config", "--quiet"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          HOME: process.env.HOME ?? "",
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          ...exportedValues,
        },
      },
    ),
  };
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("deploy-compose authoritative env routing", () => {
  it("uses the shared overlay and removes exported values that could override the file", () => {
    const { envPath, result } = runWrapper(
      {
        DEPLOY_MODE: "shared",
        AO_POSTGRES_VOLUME_MODE: "new",
        COMPOSE_PROJECT_NAME: "ao-v2",
        DATABASE_SCHEMA_SYNC: "0",
      },
      {
        DEPLOY_MODE: "bundled",
        AO_POSTGRES_VOLUME_MODE: "external",
        AO_EXISTING_POSTGRES_VOLUME: "old-volume",
        COMPOSE_PROJECT_NAME: "host-override",
        DATABASE_SCHEMA_SYNC: "1",
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`AO_ENV_FILE=${envPath}`);
    expect(result.stdout).toContain("COMPOSE_PROJECT_NAME=\n");
    expect(result.stdout).toContain("DATABASE_SCHEMA_SYNC=\n");
    expect(result.stdout).toContain("DEPLOY_MODE=\n");
    expect(result.stdout).toContain("AO_POSTGRES_VOLUME_MODE=\n");
    expect(result.stdout).toContain("AO_EXISTING_POSTGRES_VOLUME=\n");
    expect(result.stdout).toContain(`ARG=${join(repoRoot, "docker-compose.deploy.yml")}`);
    expect(result.stdout).toContain(`ARG=${join(repoRoot, "docker-compose.shared-inngest.yml")}`);
    expect(result.stdout).not.toContain("docker-compose.reuse-postgres-volume.yml");
  });

  it("uses only the base file for explicit bundled mode", () => {
    const { result } = runWrapper({
        DEPLOY_MODE: "bundled",
        AO_POSTGRES_VOLUME_MODE: "new",
        DATABASE_SCHEMA_SYNC: "1",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`ARG=${join(repoRoot, "docker-compose.deploy.yml")}`);
    expect(result.stdout).not.toContain("docker-compose.shared-inngest.yml");
    expect(result.stdout).not.toContain("docker-compose.reuse-postgres-volume.yml");
  });

  it("adds the existing-volume overlay only for explicit external mode", () => {
    const { result } = runWrapper({
      DEPLOY_MODE: "shared",
      AO_POSTGRES_VOLUME_MODE: "external",
      AO_EXISTING_POSTGRES_VOLUME: "verified-old-volume",
      DATABASE_SCHEMA_SYNC: "0",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`ARG=${join(repoRoot, "docker-compose.shared-inngest.yml")}`);
    expect(result.stdout).toContain(
      `ARG=${join(repoRoot, "docker-compose.reuse-postgres-volume.yml")}`,
    );
  });

  it("fails closed when a mode-specific command targets a different stack", () => {
    const { result } = runWrapper(
      {
        DEPLOY_MODE: "shared",
        AO_POSTGRES_VOLUME_MODE: "new",
        DATABASE_SCHEMA_SYNC: "0",
      },
      {},
      ["--expect-mode", "bundled", "--expect-volume-mode", "new"],
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("expects DEPLOY_MODE=bundled");
    expect(result.stdout).toBe("");
  });

  it("rejects automatic schema sync for shared or external targets", () => {
    const shared = runWrapper({
      DEPLOY_MODE: "shared",
      AO_POSTGRES_VOLUME_MODE: "new",
      DATABASE_SCHEMA_SYNC: "1",
    }).result;
    expect(shared.status).toBe(1);
    expect(shared.stderr).toContain("requires DATABASE_SCHEMA_SYNC=0");

    const external = runWrapper({
      DEPLOY_MODE: "bundled",
      AO_POSTGRES_VOLUME_MODE: "external",
      DATABASE_SCHEMA_SYNC: "1",
    }).result;
    expect(external.status).toBe(1);
    expect(external.stderr).toContain("requires DATABASE_SCHEMA_SYNC=0");
  });
});

describe("deploy-compose document converter contract", () => {
  it("keeps Gotenberg internal-only and makes app wait for converter health", () => {
    const compose = readFileSync(join(repoRoot, "docker-compose.deploy.yml"), "utf8");
    const serviceBlock = /\n  gotenberg:\n([\s\S]*?)\n  app:\n/.exec(compose)?.[1];

    expect(serviceBlock).toBeDefined();
    expect(serviceBlock).toContain("gotenberg/gotenberg:8.34.0-libreoffice");
    expect(serviceBlock).toContain("LIBREOFFICE_DENY_PRIVATE_IPS");
    expect(serviceBlock).toContain("LIBREOFFICE_DENY_PUBLIC_IPS");
    expect(serviceBlock).toContain("- converter-internal");
    expect(serviceBlock).not.toMatch(/^    ports:/m);
    expect(serviceBlock).not.toMatch(/^    volumes:/m);

    expect(compose).toMatch(/gotenberg:\n\s+condition: service_healthy/);
    expect(compose).toMatch(/converter-internal:\n\s+internal: true/);
  });

  it("does not add Gotenberg to the shared RAAS network or alter durable volumes", () => {
    const base = readFileSync(join(repoRoot, "docker-compose.deploy.yml"), "utf8");
    const shared = readFileSync(join(repoRoot, "docker-compose.shared-inngest.yml"), "utf8");

    expect(shared).not.toMatch(/^  gotenberg:/m);
    expect(base).toContain("- ao-postgres-data:/var/lib/postgresql/data");
    expect(base).toContain("- ao-inngest-data:/var/lib/inngest/.inngest");
    expect(base).toContain("- ao-logs:/app/persist");
  });
});
