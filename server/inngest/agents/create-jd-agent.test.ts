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
