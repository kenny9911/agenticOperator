// create-jd-agent.test.ts — unit tests for createJD helper logic.
//
// Focus: proseToSkillArray — converts RoboHire generate-jd free-text
// hardRequirements / niceToHave prose into the structured skill arrays
// (must_have_skills / nice_to_have_skills) stored on Job_Requisition.

import { describe, it, expect, vi } from 'vitest';

// Mock the inngest client so importing the agent module doesn't register a
// real function at module load.
vi.mock('@/server/inngest/client', () => ({
  inngest: {
    createFunction: vi.fn((cfg: unknown, handler: unknown) => ({ cfg, handler })),
  },
}));

import {
  proseToSkillArray,
  isAoSideBadRequest,
  resolveJdTitle,
  resolveSkillArray,
  buildPromptFromRequirement,
} from './create-jd-agent';
import { RobohireApiError } from '@/lib/robohire-client';

describe('proseToSkillArray', () => {
  it('splits numbered hardRequirements prose into discrete items', () => {
    const input =
      '1. 必须为统招本科及以上学历（学信网可查）。\n2. 能够熟练使用 Python 进行功能开发与脚本编写。\n3. 工作地点位于深圳南山区，需线下全职办公。';
    expect(proseToSkillArray(input)).toEqual([
      '必须为统招本科及以上学历（学信网可查）。',
      '能够熟练使用 Python 进行功能开发与脚本编写。',
      '工作地点位于深圳南山区，需线下全职办公。',
    ]);
  });

  it('splits dash-bulleted niceToHave prose into discrete items', () => {
    const input =
      '- 有过个人开源 AI 项目或在 GitHub 上活跃参与过 AI 相关仓库贡献。\n- 熟悉 Docker 容器化部署及基础的 Linux 命令。';
    expect(proseToSkillArray(input)).toEqual([
      '有过个人开源 AI 项目或在 GitHub 上活跃参与过 AI 相关仓库贡献。',
      '熟悉 Docker 容器化部署及基础的 Linux 命令。',
    ]);
  });

  it('strips Chinese-style and parenthesized numbering', () => {
    expect(proseToSkillArray('1、甲\n2）乙')).toEqual(['甲', '乙']);
  });

  it('strips bullet glyphs (• · *)', () => {
    expect(proseToSkillArray('• A\n· B\n* C')).toEqual(['A', 'B', 'C']);
  });

  it('drops blank lines', () => {
    expect(proseToSkillArray('- A\n\n  \n- B')).toEqual(['A', 'B']);
  });

  it('keeps an unmarked single line as one item', () => {
    expect(proseToSkillArray('扎实的工程基础')).toEqual(['扎实的工程基础']);
  });

  it('returns empty array for non-string / empty input', () => {
    expect(proseToSkillArray(undefined)).toEqual([]);
    expect(proseToSkillArray(null)).toEqual([]);
    expect(proseToSkillArray(123)).toEqual([]);
    expect(proseToSkillArray('   ')).toEqual([]);
  });
});

describe('isAoSideBadRequest — AO 自己的 4xx 不该记成 RoboHire 健康退化', () => {
  it('400/422(我们发的 prompt 有问题)→ true(失败但不写 RoboHire dependency 信号)', () => {
    expect(isAoSideBadRequest(new RobohireApiError(400, 'CLIENT', 'prompt invalid'))).toBe(true);
    expect(isAoSideBadRequest(new RobohireApiError(422, 'CLIENT', 'unprocessable'))).toBe(true);
  });

  it('401/403(密钥/凭证)/429/5xx/network → false(仍走厂商健康分类)', () => {
    expect(isAoSideBadRequest(new RobohireApiError(401, 'CLIENT', 'unauthorized'))).toBe(false);
    expect(isAoSideBadRequest(new RobohireApiError(403, 'CLIENT', 'forbidden'))).toBe(false);
    expect(isAoSideBadRequest(new RobohireApiError(429, 'RATE_LIMITED', 'slow'))).toBe(false);
    expect(isAoSideBadRequest(new RobohireApiError(503, 'SERVER', 'down'))).toBe(false);
    expect(isAoSideBadRequest(new RobohireApiError(0, 'NETWORK', 'econnreset'))).toBe(false);
  });

  it('非 RobohireApiError(普通 Error / 其它)→ false', () => {
    expect(isAoSideBadRequest(new Error('boom'))).toBe(false);
    expect(isAoSideBadRequest(null)).toBe(false);
    expect(isAoSideBadRequest('nope')).toBe(false);
  });
});

describe('resolveJdTitle', () => {
  it('keeps RoboHire title after the strict stage gate has passed', () => {
    expect(resolveJdTitle('高级前端工程师', '需求侧标题')).toBe('高级前端工程师');
  });
  it('non-string or blank title → uses fallback', () => {
    expect(resolveJdTitle(undefined, 'fallback')).toBe('fallback');
    expect(resolveJdTitle('   ', 'fallback')).toBe('fallback');
  });
});

describe('resolveSkillArray — 重新生成必须能改掉上一轮派生的技能数组', () => {
  const OLD = ['上一轮 Gohire 派生的旧技能'];
  const NEW = ['本轮 Gohire 派生的新技能'];

  it('force_regenerate=true → 用本轮新派生值(旧值不再冻结结果)', () => {
    expect(resolveSkillArray(OLD, NEW, { forceRegenerate: true })).toEqual(NEW);
  });

  it('force_regenerate=true 但本轮派生为空 → 回退旧值,不清空下游依赖的数组', () => {
    expect(resolveSkillArray(OLD, [], { forceRegenerate: true })).toEqual(OLD);
  });

  it('普通首轮/重放 → 保持既有语义:已有值优先', () => {
    expect(resolveSkillArray(OLD, NEW, { forceRegenerate: false })).toEqual(OLD);
    expect(resolveSkillArray(OLD, NEW)).toEqual(OLD);
  });

  it('两侧都为空 → undefined(让调用方回退到 requirement 原值)', () => {
    expect(resolveSkillArray(null, [], { forceRegenerate: true })).toBeUndefined();
    expect(resolveSkillArray(undefined, [])).toBeUndefined();
  });
});

describe('buildPromptFromRequirement — 只拼候选人该看到的字段', () => {
  // 一条「已被上一轮 createJD 回写过」的需求:must/nice_to_have_skills 里装的是
  // 上一轮 Gohire 自己的输出,日期和期望级别都是内部口径。
  const requirement = {
    client_job_title: '前端工程师',
    city: '深圳',
    expected_level: 'P7',
    client_published_at: '2026-08-01T16:00:00.000Z',
    open_date: '2026-07-20T16:00:00.000Z',
    required_arrival_date: '2026-09-01T16:00:00.000Z',
    must_have_skills: ['上一轮 Gohire 派生:精通 React'],
    nice_to_have_skills: ['上一轮 Gohire 派生:熟悉 Docker'],
    job_responsibility: '负责 C 端页面研发。',
    job_requirement: '三年以上前端经验，熟悉 React。',
  } as never;
  const specification = {
    start_date: '2026-08-15T16:00:00.000Z',
    deadline: '2026-09-10T16:00:00.000Z',
  } as never;

  const prompt = buildPromptFromRequirement(requirement, specification);

  it('不拼期望级别(客户自家级别区间,无通用映射且可反推客户身份)', () => {
    expect(prompt).not.toContain('期望级别');
    expect(prompt).not.toContain('P7');
  });

  it('不拼任何日期(generate-jd 从不回吐日期,只会被写进候选人可见正文)', () => {
    expect(prompt).not.toContain('发布日期');
    expect(prompt).not.toContain('期望到岗日期');
    expect(prompt).not.toContain('服务开始日期');
    expect(prompt).not.toMatch(/2026-0[789]-\d{2}/);
  });

  it('不拼 must/nice_to_have_skills —— 那是本 agent 自己回写的,拼回去构成自反馈回路', () => {
    expect(prompt).not.toContain('必备技能');
    expect(prompt).not.toContain('加分技能');
    expect(prompt).not.toContain('上一轮 Gohire 派生');
  });

  it('客户原始录入的内容仍然完整进 prompt', () => {
    expect(prompt).toContain('岗位: 前端工程师');
    expect(prompt).toContain('工作城市: 深圳');
    expect(prompt).toContain('负责 C 端页面研发。');
    expect(prompt).toContain('三年以上前端经验，熟悉 React。');
  });
});
