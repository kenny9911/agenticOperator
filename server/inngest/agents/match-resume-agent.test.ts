// match-resume-agent.test.ts — regression tests for the pre-RoboHire rule-check gate.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/inngest/client', () => ({
  inngest: {
    createFunction: vi.fn((cfg: unknown, handler: unknown) => ({ cfg, handler })),
  },
}));

vi.mock('@/lib/partner-pg/match-results', () => ({
  saveMatchResultsToPartnerPg: vi.fn(async () => ({
    candidate_match_result_id: 'cmr_C1_JR1',
    candidate_id: 'C1',
    job_requisition_id: 'JR1',
    created: true,
    job_posting_id: 'JP1',
  })),
}));

vi.mock('@/lib/allmeta-writers', () => ({
  writeCandidateMatchResultInstance: vi.fn(async () => ({ ok: true })),
}));

vi.mock('@/lib/robohire-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/robohire-client')>(
    '@/lib/robohire-client',
  );
  return {
    ...actual,
    matchResumeDirect: vi.fn(async () => ({
      data: { matchScore: 82, recommendation: 'GOOD_MATCH' },
      requestId: 'rh_req_1',
      savedAs: 'robohire-match-1',
    })),
  };
});

vi.mock('@/lib/agent-logger', () => ({
  createAgentLogger: vi.fn(() => ({
    event: vi.fn(),
    apiCall: vi.fn(),
  })),
  runWithLogger: vi.fn(async (_logger: unknown, fn: () => unknown) => fn()),
}));

vi.mock('@/lib/dependency-health/report', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dependency-health/report')>();
  return {
    ...actual,
    reportDependencyDegraded: vi.fn(async () => {}),
  };
});

const notifyRecruitmentLifecycle = vi.fn(async (_step: unknown, _signal: unknown, _ctx: unknown) => {});
vi.mock('@/server/notifications/recruitment-lifecycle', () => ({
  notifyRecruitmentLifecycle: (step: unknown, signal: unknown, ctx: unknown) =>
    notifyRecruitmentLifecycle(step, signal, ctx),
}));
const recordNotification = vi.fn(async (_input: unknown) => ({ id: 'n1' }));
vi.mock('@/server/notifications/ingest', () => ({
  recordNotification: (input: unknown) => recordNotification(input),
}));

import {
  buildResumeTextFromParsed,
  matchResumeAgentHandler,
  verifyRuleCheckPassedForMatch,
} from './match-resume-agent';
import { matchResumeDirect } from '@/lib/robohire-client';

const mockMatchResumeDirect = matchResumeDirect as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  notifyRecruitmentLifecycle.mockClear();
  recordNotification.mockClear();
});

function fakeStep() {
  const runs: string[] = [];
  const events: Array<{ key: string; payload: { name: string; data: any } }> = [];
  return {
    calls: { runs, events },
    step: {
      run: async (key: string, fn: () => Promise<unknown>) => {
        runs.push(key);
        return await fn();
      },
      sendEvent: async (key: string, payload: { name: string; data: any }) => {
        events.push({ key, payload });
      },
    },
  };
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function passedData(overrides: Record<string, unknown> = {}) {
  return {
    candidate_id: 'C1',
    resume_id: 'R1',
    job_requisition_id: 'JR1',
    client_id: 'CLI_TENCENT',
    rule_check_result: '通过',
    rule_check_reason: '',
    upload_id: 'U1',
    employee_id: 'E1',
    audit: {
      rules_evaluated: 2,
      graph_calls: 1,
      client_id: 'CLI_TENCENT',
      business_group: null,
      studio: null,
      llm_model: 'gemini',
      llm_duration_ms: 10,
      llm_round_trips: 1,
      rule_source: 'ontology-api',
    },
    rule_check_rules: [
      { rule_id: '10-25', rule_name: '学历底线', status: 'pass', reason: '本科,满足岗位要求' },
      { rule_id: '10-42', rule_name: 'CDG 回流冷冻', status: 'not_triggered', reason: '无腾讯任职经历' },
    ],
    job_requisition: {
      job_requisition_id: 'JR1',
      client_id: 'CLI_TENCENT',
      client_job_title: '后端工程师',
      must_have_skills: ['TypeScript', 'Node.js'],
      job_responsibility: '负责招聘系统后端开发',
    },
    parsed_resume: { name: '张三', skills: ['TypeScript'] },
    parsed_content: '张三,后端工程师,TypeScript 五年经验',
    runtime_context: {
      upload_id: 'U1',
      candidate_id: 'C1',
      resume_id: 'R1',
      employee_id: 'E1',
      trace_id: 'trace-1',
    },
    ...overrides,
  };
}

async function runHandler(data: Record<string, unknown>) {
  const { step, calls } = fakeStep();
  const result = await matchResumeAgentHandler({
    event: { name: 'MATCH_RULE_CHECK_PASSED', data },
    step,
    logger,
    runId: 'run-1',
  });
  return { result, calls };
}

describe('verifyRuleCheckPassedForMatch', () => {
  it('rejects bypass-shaped PASSED events', () => {
    expect(
      verifyRuleCheckPassedForMatch(
        passedData({
          audit: {
            ...(passedData().audit as Record<string, unknown>),
            rules_evaluated: 0,
            llm_model: 'bypass',
            fail_reason: 'bypassed',
          },
          rule_check_rules: undefined,
        }) as any,
      ),
    ).toMatchObject({ ok: false, reason: 'rule-check-bypassed' });
  });

  it('requires per-rule results before matching can proceed', () => {
    expect(
      verifyRuleCheckPassedForMatch(passedData({ rule_check_rules: [] }) as any),
    ).toMatchObject({ ok: false, reason: 'rule-check-rules-missing' });
  });

  it('allows an optional/reference-only fail to proceed', () => {
    expect(
      verifyRuleCheckPassedForMatch(
        passedData({
          rule_check_rules: [
            {
              rule_id: 'O-1',
              rule_name: '参考提示',
              status: 'fail',
              enforcement_level: 'optional',
              blocking: false,
            },
          ],
        }) as any,
      ),
    ).toEqual({ ok: true });
  });
});

describe('matchResumeAgentHandler — pre-RoboHire rule-check gate', () => {
  it('does not call RoboHire when RULE_CHECK_BYPASS emitted a pass-like event', async () => {
    const { result, calls } = await runHandler(
      passedData({
        audit: {
          ...(passedData().audit as Record<string, unknown>),
          rules_evaluated: 0,
          llm_model: 'bypass',
          fail_reason: 'bypassed',
        },
        rule_check_rules: undefined,
      }),
    );

    expect(result).toMatchObject({ ok: false, error: 'rule-check-bypassed' });
    expect(mockMatchResumeDirect).not.toHaveBeenCalled();
    expect(calls.runs).toHaveLength(0);
    expect(recordNotification).toHaveBeenCalledWith(
      expect.objectContaining({ dedupeHint: 'match_precondition.rule-check-bypassed' }),
    );
  });

  it('does not call RoboHire when the pass event lacks rule_check_rules evidence', async () => {
    const { result, calls } = await runHandler(passedData({ rule_check_rules: undefined }));

    expect(result).toMatchObject({ ok: false, error: 'rule-check-rules-missing' });
    expect(mockMatchResumeDirect).not.toHaveBeenCalled();
    expect(calls.runs).toHaveLength(0);
  });

  it('calls RoboHire for a real rule-check pass and appends the rule block to jd', async () => {
    const { result, calls } = await runHandler(passedData());

    expect(result).toMatchObject({ ok: true, eventName: 'MATCH_PASSED_NEED_INTERVIEW' });
    expect(calls.runs).toContain('match-JR1');
    expect(mockMatchResumeDirect).toHaveBeenCalledTimes(1);
    const [payload] = mockMatchResumeDirect.mock.calls[0] as [{ resume: string; jd: string }];
    expect(payload.resume).toContain('张三');
    expect(payload.jd).toContain('入岗前规则检查结论');
    expect(payload.jd).toContain('系统注入,非岗位 JD 原文');
    expect(payload.jd).toContain('10-25 学历底线:通过');
  });
});

describe('matchResumeAgentHandler — 候选人期望接入 candidatePreferences', () => {
  it('从简历文本抽到期望时,作为 candidatePreferences 传给 RoboHire', async () => {
    await runHandler(
      passedData({
        parsed_resume: { name: '李四', skills: ['Go'] },
        parsed_content: '李四 后端\n期望职位：后端工程师\n期望城市：深圳、广州\n期望薪资：15-20K',
      }),
    );
    const [payload] = mockMatchResumeDirect.mock.calls[0] as [
      { candidatePreferences?: string },
    ];
    expect(payload.candidatePreferences).toBeTruthy();
    expect(payload.candidatePreferences).toContain('后端工程师');
    expect(payload.candidatePreferences).toContain('深圳');
    expect(payload.candidatePreferences).toContain('15000');
  });

  it('事件已带结构化 candidate_expectation 时优先用它', async () => {
    await runHandler(
      passedData({
        candidate_expectation: {
          expected_salary_monthly_min: 30000,
          expected_salary_monthly_max: 40000,
          expected_cities: ['北京'],
          expected_industries: [],
          expected_roles: ['架构师'],
          expected_work_mode: '远程',
        },
        parsed_content: '与结构化期望无关的简历原文',
      }),
    );
    const [payload] = mockMatchResumeDirect.mock.calls[0] as [
      { candidatePreferences?: string },
    ];
    expect(payload.candidatePreferences).toContain('架构师');
    expect(payload.candidatePreferences).toContain('北京');
    expect(payload.candidatePreferences).toContain('远程');
  });

  it('抽不到任何期望时不传 candidatePreferences(与旧行为一致)', async () => {
    await runHandler(passedData());
    const [payload] = mockMatchResumeDirect.mock.calls[0] as [
      { candidatePreferences?: string },
    ];
    expect(payload.candidatePreferences).toBeUndefined();
  });
});

describe('buildResumeTextFromParsed — RoboHire 结构化 → 干净简历文本', () => {
  // 真实 RoboHire 解析形状(取自 __fixtures__/real-run-chensiying.ts)。
  const structured = {
    name: '陈思',
    phone: '138****0000',
    email: 'redacted@example.com',
    experience: [
      { company: '字节跳动（深圳）科技有限公司', title: '行政文秘专员', startDate: '2024.03', endDate: '至今' },
      { company: '深圳本技有限公司', title: '行政助理', startDate: '2021.07', endDate: '2024.02' },
    ],
    education: [{ school: '北京师范大学', degree: '本科', major: '汉语言文学（师范）', endDate: '2021.06' }],
    skills: { technical: ['Excel 数据透视', '公文写作'], tools: ['飞书', '企业微信', '腾讯文档'] },
  };

  it('把结构化字段渲染成带标签的可读文本,而非裸 JSON', () => {
    const text = buildResumeTextFromParsed(structured);
    // 人读得懂的值都在
    expect(text).toContain('陈思');
    expect(text).toContain('字节跳动（深圳）科技有限公司');
    expect(text).toContain('行政文秘专员');
    expect(text).toContain('北京师范大学');
    expect(text).toContain('汉语言文学（师范）');
    expect(text).toContain('Excel 数据透视');
    expect(text).toContain('飞书');
    // 不是裸 JSON 语法(键名/花括号/引号噪声)
    expect(text).not.toContain('"technical"');
    expect(text).not.toContain('{"');
  });

  it('无法抽取任何已知字段时返回空串(交给上层回退 rawText)', () => {
    expect(buildResumeTextFromParsed(null)).toBe('');
    expect(buildResumeTextFromParsed(undefined)).toBe('');
    expect(buildResumeTextFromParsed({})).toBe('');
    expect(buildResumeTextFromParsed({ unknown_field: 1 })).toBe('');
  });

  it('已是纯文本的简历原样返回', () => {
    expect(buildResumeTextFromParsed('张三 后端工程师' as never)).toContain('张三 后端工程师');
  });
});

describe('matchResumeAgentHandler — resume 入参改用结构化渲染', () => {
  it('优先把结构化渲染文本作为 resume 发给 RoboHire,而非 rawText 原文', async () => {
    await runHandler(
      passedData({
        parsed_resume: { name: '李四', skills: { technical: ['Kubernetes'] } },
        parsed_content: 'RAWTEXT_NOT_PRIMARY 李四 简历原始文字',
      }),
    );
    const [payload] = mockMatchResumeDirect.mock.calls[0] as [{ resume: string }];
    expect(payload.resume).toContain('Kubernetes'); // 结构化字段被渲染进去
    expect(payload.resume).not.toContain('RAWTEXT_NOT_PRIMARY'); // 不再以 rawText 为主
  });

  it('结构化为空时回退到 rawText(parsed_content),不发空简历', async () => {
    await runHandler(
      passedData({
        parsed_resume: {},
        parsed_content: '李四 简历纯文本兜底',
      }),
    );
    const [payload] = mockMatchResumeDirect.mock.calls[0] as [{ resume: string }];
    expect(payload.resume).toContain('李四 简历纯文本兜底');
  });
});
