// GET/PATCH /api/system/env-config — dynamic environment configuration.
// Reads .env* files through server/ops/runtime-config and returns only
// redacted/safe values for the operator UI.

import { NextResponse } from "next/server";
import {
  applyRuntimeConfigToEnv,
  getRuntimeConfigState,
  saveRuntimeConfig,
  type RuntimeConfigSaveTarget,
  type RuntimeConfigState,
} from "@/server/ops/runtime-config";
import { getInfraStatus, type InfraStatusSnapshot } from "@/server/ops/infra-status";
import { closeDriver as closeNeo4jDriver } from "@/server/em/clients/neo4j";

export const dynamic = "force-dynamic";

export type SystemEnvConfigResponse = {
  runtimeConfig: RuntimeConfigState;
  infra: InfraStatusSnapshot;
  generatedAt: string;
};

export type SystemEnvConfigUpdateResponse =
  | {
      ok: true;
      target: RuntimeConfigSaveTarget;
      changedKeys: string[];
      restartRequiredKeys: string[];
      config: SystemEnvConfigResponse;
    }
  | { ok: false; error: string };

async function buildResponse(): Promise<SystemEnvConfigResponse> {
  await applyRuntimeConfigToEnv();
  const [runtimeConfig, infra] = await Promise.all([
    getRuntimeConfigState(),
    getInfraStatus(),
  ]);
  return {
    runtimeConfig,
    infra,
    generatedAt: new Date().toISOString(),
  };
}

export async function GET(): Promise<Response> {
  return NextResponse.json(await buildResponse());
}

export async function PATCH(req: Request): Promise<Response> {
  let values: unknown;
  let target: RuntimeConfigSaveTarget | undefined;
  try {
    const payload = (await req.json()) as { values?: unknown; target?: unknown };
    values = payload.values;
    target = payload.target === "runtime" ? "runtime" : "env_local";
  } catch {
    return NextResponse.json<SystemEnvConfigUpdateResponse>({ ok: false, error: "INVALID_JSON" }, { status: 400 });
  }

  if (!values || typeof values !== "object" || Array.isArray(values)) {
    return NextResponse.json<SystemEnvConfigUpdateResponse>({ ok: false, error: "INVALID_VALUES" }, { status: 400 });
  }

  try {
    const result = await saveRuntimeConfig(values as Record<string, unknown>, { target });
    if (result.changedKeys.some((k) => k.startsWith("NEO4J_"))) {
      await closeNeo4jDriver().catch(() => undefined);
    }
    return NextResponse.json<SystemEnvConfigUpdateResponse>({
      ok: true,
      target: result.target,
      changedKeys: result.changedKeys,
      restartRequiredKeys: result.restartRequiredKeys,
      config: await buildResponse(),
    });
  } catch (e) {
    return NextResponse.json<SystemEnvConfigUpdateResponse>(
      { ok: false, error: (e as Error).message },
      { status: 400 },
    );
  }
}
