// rule-check-agent.jr-ids.test.ts — ADR-0040 path-B' 覆盖测试。
//
// 验证:RESUME_PROCESSED 带预填窄化数组 job_requisition_ids 且单数
// job_requisition_id 为空时,ruleCheckAgent 直接对数组里每个 JR 取详情撮合,
// 跳过 path-B「按 employee_id 扫该招聘员名下全部在招岗位」。
//
// 注:本文件 mock 的是 agent 当前真实依赖(@/lib/partner-pg/* + @/server/db +
// @/lib/agent-logger),与同目录 rule-check-agent.test.ts(迁移前的 raas-api-client
// mock)不同 —— 后者已 stale,本文件按现状写。

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/server/inngest/client', () => ({
  inngest: { createFunction: vi.fn((cfg: unknown, handler: unknown) => ({ cfg, handler })) },
}));
// @/server/db 在 import 时即构造真实 PrismaClient(本地无 PG),必须 mock 掉。
vi.mock('@/server/db', () => ({
  prisma: (() => {
    const tx = {
      ruleCheckAudit: { upsert: vi.fn(async () => ({})) },
      ruleCheckFlag: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        createMany: vi.fn(async () => ({ count: 0 })),
      },
    };
    return {
      ...tx,
      $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
      notification: {
        findMany: vi.fn(async () => []),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
    };
  })(),
}));
vi.mock('@/lib/agent-logger', () => ({
  createAgentLogger: vi.fn(() => ({ event: vi.fn() })),
  // runWithLogger 包裹整个 handler body —— 必须真正调用 fn 才能拿到返回值。
  runWithLogger: vi.fn(async (_logger: unknown, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('@/lib/rule-check', () => ({
  buildRuleCheckInput: vi.fn((x: unknown) => x),
  formatExplanation: vi.fn((e: { rule_id: string; reason?: string }) =>
    `[${e.rule_id}] ${e.reason ?? ''}`,
  ),
  runRuleCheck: vi.fn(),
}));
vi.mock('@/lib/rule-check/ontology', () => ({
  extractDims: vi.fn(() => ({ client_id: 'C', business_group: null, studio: null })),
  loadAllRules: vi.fn(() => []),
  severityForRuleId: vi.fn(() => 'low'),
}));
vi.mock('@/lib/partner-pg/client', () => ({ isPartnerPgConfigured: vi.fn(() => true) }));
vi.mock('@/lib/partner-pg/requirements', () => ({ getRequirementDetail: vi.fn() }));
vi.mock('@/lib/partner-pg/agent-view', () => ({ getRequirementsAgentView: vi.fn() }));
vi.mock('@/lib/partner-pg/recruiting-jobs', () => ({ getRecruitingJobsAsRequirements: vi.fn() }));
vi.mock('@/lib/partner-pg/parsed-resume', () => ({ getParsedResume: vi.fn() }));
vi.mock('@/lib/partner-pg/rule-check-result', () => ({ saveRuleCheckFailToPartnerPg: vi.fn() }));
vi.mock('@/lib/allmeta-writers', () => ({
  writeJobRequisitionInstance: vi.fn(async () => ({ ok: true })),
  writeCandidateMatchResultInstance: vi.fn(async () => ({ ok: true })),
}));

import { ruleCheckAgentHandler } from './rule-check-agent';
import { runRuleCheck } from '@/lib/rule-check';
import { getRequirementDetail } from '@/lib/partner-pg/requirements';
import { getRequirementsAgentView } from '@/lib/partner-pg/agent-view';
import { getRecruitingJobsAsRequirements } from '@/lib/partner-pg/recruiting-jobs';

const mockRunRuleCheck = runRuleCheck as ReturnType<typeof vi.fn>;
const mockGetRequirementDetail = getRequirementDetail as ReturnType<typeof vi.fn>;
const mockGetRequirementsAgentView = getRequirementsAgentView as ReturnType<typeof vi.fn>;
const mockGetRecruitingJobs = getRecruitingJobsAsRequirements as ReturnType<typeof vi.fn>;

function detailFor(id: string) {
  return {
    job_requisition_id: id,
    client_id: 'CLI_X',
    client_job_title: 'Java开发工程师',
    must_have_skills: ['java'],
    job_responsibility: '写后端',
    specification: {},
  };
}

// thick event: parsed.data 已在,跳过 F1 回拉,简化 mock 面。
function evt(over: Record<string, unknown> = {}) {
  return {
    name: 'RESUME_PROCESSED',
    data: {
      upload_id: 'U1',
      candidate_id: 'C1',
      resume_id: 'R1',
      employee_id: 'EMP_TEST',
      filename: 'Java开发-深圳-黄乾洲.pdf',
      parsed: { data: { name: 'John', skills: ['java'] } },
      job_requisition_id: null,
      ...over,
    },
  };
}

function mockStep() {
  const sent: Array<{ name: string; data: any }> = [];
  return {
    sent,
    run: async (_id: string, fn: () => Promise<unknown>) => fn(),
    sendEvent: async (_id: string, e: { name: string; data: any }) => {
      sent.push(e);
    },
  };
}
const mockLogger = { info: () => {}, warn: () => {}, error: () => {} };

const PASS = {
  decision: 'PASS',
  stats: { total: 1, pass: 1, fail: 0, pending: 0, insufficient_info: 0, not_triggered: 0, not_executed: 0 },
  rule_results: [],
  explanations: [],
  audit: { rules_evaluated: 1, graph_calls: 0, llm_model: 'gemini', llm_duration_ms: 1, llm_round_trips: 0, rule_source: 'json-fallback' },
};

beforeEach(() => vi.clearAllMocks());

describe("ruleCheckAgent — path B' (ADR-0040 预填 job_requisition_ids)", () => {
  it('直接对数组里每个 JR 取详情并 fan-out,不调 path-B 名下全量扫描', async () => {
    mockGetRequirementDetail.mockImplementation(async (id: string) => detailFor(id));
    mockRunRuleCheck.mockResolvedValue(PASS as any);

    const step = mockStep();
    await ruleCheckAgentHandler({
      event: evt({ job_requisition_id: null, job_requisition_ids: ['JR1', 'JR2'] }) as any,
      step: step as any,
      logger: mockLogger as any,
    });

    // 对数组每个 id 取详情
    expect(mockGetRequirementDetail).toHaveBeenCalledTimes(2);
    expect(mockGetRequirementDetail).toHaveBeenCalledWith('JR1');
    expect(mockGetRequirementDetail).toHaveBeenCalledWith('JR2');
    // 关键:跳过 path-B「按 employee_id 扫名下全部在招岗位」
    expect(mockGetRecruitingJobs).not.toHaveBeenCalled();
    expect(mockGetRequirementsAgentView).not.toHaveBeenCalled();
    // 每个 JR 各 fan-out 一条 MATCH_RULE_CHECK_PASSED
    expect(step.sent).toHaveLength(2);
    expect(step.sent.map((e) => e.name)).toEqual(['MATCH_RULE_CHECK_PASSED', 'MATCH_RULE_CHECK_PASSED']);
    expect(step.sent.map((e) => e.data.job_requisition_id).sort()).toEqual(['JR1', 'JR2']);
  });

  it('去重 + 忽略空串后再循环', async () => {
    mockGetRequirementDetail.mockImplementation(async (id: string) => detailFor(id));
    mockRunRuleCheck.mockResolvedValue(PASS as any);

    const step = mockStep();
    await ruleCheckAgentHandler({
      event: evt({ job_requisition_id: null, job_requisition_ids: ['JR1', ' JR1 ', '', 'JR2'] }) as any,
      step: step as any,
      logger: mockLogger as any,
    });

    expect(mockGetRequirementDetail).toHaveBeenCalledTimes(2); // JR1 去重 + 空串丢弃
    expect(mockGetRecruitingJobs).not.toHaveBeenCalled();
  });

  it('单数 job_requisition_id 存在时优先 path-A,忽略数组', async () => {
    mockGetRequirementDetail.mockImplementation(async (id: string) => detailFor(id));
    mockRunRuleCheck.mockResolvedValue(PASS as any);

    const step = mockStep();
    await ruleCheckAgentHandler({
      event: evt({ job_requisition_id: 'JRX', job_requisition_ids: ['JR1', 'JR2'] }) as any,
      step: step as any,
      logger: mockLogger as any,
    });

    expect(mockGetRequirementDetail).toHaveBeenCalledTimes(1);
    expect(mockGetRequirementDetail).toHaveBeenCalledWith('JRX');
    expect(mockGetRecruitingJobs).not.toHaveBeenCalled();
    expect(step.sent).toHaveLength(1);
    expect(step.sent[0].data.job_requisition_id).toBe('JRX');
  });

  it('数组与单数都空时落到 path-B 名下全量扫描', async () => {
    mockGetRecruitingJobs.mockResolvedValue({ items: [] });

    const step = mockStep();
    const r = await ruleCheckAgentHandler({
      event: evt({ job_requisition_id: null, job_requisition_ids: [] }) as any,
      step: step as any,
      logger: mockLogger as any,
    });

    expect(mockGetRecruitingJobs).toHaveBeenCalledTimes(1);
    expect(mockGetRequirementDetail).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, reason: 'no-published-jr-claimed-by-recruiter' });
  });

  it('数组里 JR 在 partner DB 取不到 → 跳过该 id,全取不到则早退 no-matchable-requirements', async () => {
    mockGetRequirementDetail.mockResolvedValue(null);

    const step = mockStep();
    const r = await ruleCheckAgentHandler({
      event: evt({ job_requisition_id: null, job_requisition_ids: ['JR1', 'JR2'] }) as any,
      step: step as any,
      logger: mockLogger as any,
    });

    expect(mockGetRequirementDetail).toHaveBeenCalledTimes(2);
    expect(mockGetRecruitingJobs).not.toHaveBeenCalled();
    expect(step.sent).toHaveLength(0);
    expect(r).toMatchObject({ ok: true, requested_count: 0, reason: 'no-matchable-requirements' });
  });
});
