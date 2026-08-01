export type SystemConfigWritePolicy = {
  enabled: boolean;
  reason:
    | "development_default"
    | "disabled_by_flag"
    | "production_flag_required"
    | "production_auth_required";
};

function flagIsEnabled(value: string | undefined): boolean {
  return value === "1";
}

function flagIsDisabled(value: string | undefined): boolean {
  return value === "0" || value === "false" || value === "off";
}

/**
 * Runtime configuration writes are intentionally fail-closed in production.
 * AO currently has no authenticated operator session that these browser routes
 * can reuse, so the feature flag alone must never turn an anonymous PATCH into
 * a production configuration write. When operator auth is added, enforce it at
 * the route boundary before changing this policy.
 */
export function getSystemConfigWritePolicy(): SystemConfigWritePolicy {
  const flag = process.env.AO_SYSTEM_CONFIG_WRITE_ENABLED?.trim().toLowerCase();

  if (process.env.NODE_ENV === "production") {
    return {
      enabled: false,
      reason: flagIsEnabled(flag) ? "production_auth_required" : "production_flag_required",
    };
  }

  if (flagIsDisabled(flag)) {
    return { enabled: false, reason: "disabled_by_flag" };
  }

  return { enabled: true, reason: "development_default" };
}
