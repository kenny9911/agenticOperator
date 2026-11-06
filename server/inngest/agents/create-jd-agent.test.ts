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
  jdStageDegradation,
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

describe('resolveJdTitle — parse-stage failure echoes the raw prompt as title (Gohire contract)', () => {
  it('parse failed → falls back to the requisition job title (raw-prompt title is unusable as a heading)', () => {
    expect(
      resolveJdTitle('岗位: 我们在招…… (4000 字原始 prompt 全文)', { parse: 'failed', generate: 'success' }, '高级前端工程师'),
    ).toBe('高级前端工程师');
  });
  it('parse succeeded → keeps RoboHire 解析出来的 title', () => {
    expect(resolveJdTitle('高级前端工程师', { parse: 'success', generate: 'success' }, '需求侧标题')).toBe('高级前端工程师');
  });
  it('parse failed + no requisition title → uses the "未命名岗位" placeholder, NEVER the raw-prompt blob', () => {
    // On parse failure RoboHire echoes the whole ~4000-char prompt as `title`. With
    // no requisition fallback, the helper must NOT keep that blob as the JD heading —
    // it substitutes the same placeholder assembleJdContent uses (未命名岗位). Using a
    // realistic long fixture so the test can't be read as "keeping the raw title is ok".
    const rawPromptBlob = '岗位: 高级后端工程师\n' + 'x'.repeat(4000);
    expect(resolveJdTitle(rawPromptBlob, { parse: 'failed', generate: 'success' }, undefined)).toBe('未命名岗位');
  });
  it('no stage info (older response shape) → keeps RoboHire title', () => {
    expect(resolveJdTitle('Some Title', undefined, 'fallback')).toBe('Some Title');
  });
  it('non-string or blank title → uses fallback', () => {
    expect(resolveJdTitle(undefined, { parse: 'success' }, 'fallback')).toBe('fallback');
    expect(resolveJdTitle('   ', { parse: 'success' }, 'fallback')).toBe('fallback');
  });
});

describe('jdStageDegradation — non-fatal degradation signal for the monitor', () => {
  it('reports which stage(s) failed', () => {
    expect(jdStageDegradation({ parse: 'failed', generate: 'success' })).toBe('parse');
    expect(jdStageDegradation({ parse: 'success', generate: 'failed' })).toBe('generate');
    expect(jdStageDegradation({ parse: 'failed', generate: 'failed' })).toBe('parse,generate');
  });
  it('null when nothing failed or no stage info (nothing to surface)', () => {
    expect(jdStageDegradation({ parse: 'success', generate: 'success' })).toBeNull();
    expect(jdStageDegradation(undefined)).toBeNull();
  });
});
