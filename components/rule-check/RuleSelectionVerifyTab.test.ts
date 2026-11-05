import { describe, expect, it } from "vitest";
import { I18N } from "@/lib/i18n";
import { identityConclusionKey } from "./RuleSelectionVerifyTab";

describe("Candidate Identity audit-only presentation", () => {
  it("maps every current dedupAction to a non-mutating audit conclusion", () => {
    expect(I18N.zh[identityConclusionKey("phone-match")]).toBe("手机号命中/同一候选人（审计结论）");
    expect(I18N.zh[identityConclusionKey("pending-review")]).toBe("疑似命中 / 只能人工复核（不自动关联）");
    expect(I18N.zh[identityConclusionKey("no-match")]).toBe("未命中 / 不自动关联");
    expect(I18N.zh[identityConclusionKey("auto-merged")]).toContain("不自动关联");

    expect(I18N.en[identityConclusionKey("phone-match")]).toContain("audit conclusion");
    expect(I18N.en[identityConclusionKey("pending-review")]).toContain("human review only");
    expect(I18N.en[identityConclusionKey("no-match")]).toContain("no automatic link");
  });

  it("marks weaker identity tiers as review signals only", () => {
    expect(I18N.zh.rc_id_tier2).toContain("仅复核信号");
    expect(I18N.zh.rc_id_tier3).toContain("仅复核信号");
    expect(I18N.en.rc_id_tier2).toContain("review signal only");
    expect(I18N.en.rc_id_tier3).toContain("review signal only");
    expect(I18N.zh.display_candidatededup_desc).toContain("不自动关联或合并档案");
    expect(I18N.en.display_candidatededup_desc).toContain("without automatically linking or merging");
  });
});
