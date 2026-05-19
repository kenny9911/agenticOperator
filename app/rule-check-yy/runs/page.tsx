import { redirect } from "next/navigation";

/**
 * Legacy URL. Phase A (2026-05-13) moved the aggregate page content to
 * `/rule-check` so the runs aggregate is the primary landing. Redirect
 * here preserves any external links pointing at the old path.
 */
export default function LegacyRunsRedirect() {
  redirect("/rule-check");
}
