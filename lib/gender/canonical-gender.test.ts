// 回归护栏 —— 生产 candidate_gender_canonical_check 违约事故 (2026-08-12)。
//
// partner Postgres 只接受 'male' | 'female' | NULL。解析器把简历上的性别原文
// 直接吐出来,写穿即整笔事务回滚(Candidate + Resume 全丢)。下面的"垃圾值"不是
// 想象出来的,是 raas_db.resume.raw_parse_result 里真实出现过的取值。

import { describe, it, expect } from 'vitest';
import { canonicalGender, isDroppedGender } from './canonical-gender';

describe('canonicalGender', () => {
  it('maps the Chinese values the parser actually returns', () => {
    expect(canonicalGender('男')).toBe('male');
    expect(canonicalGender('女')).toBe('female');
    expect(canonicalGender('男性')).toBe('male');
    expect(canonicalGender('女士')).toBe('female');
  });

  it('maps latin spellings and single letters case-insensitively', () => {
    expect(canonicalGender('Male')).toBe('male');
    expect(canonicalGender('FEMALE')).toBe('female');
    expect(canonicalGender('M')).toBe('male');
    expect(canonicalGender('f')).toBe('female');
  });

  it('folds the real-world encodings seen in raw_parse_result', () => {
    expect(canonicalGender('⼥')).toBe('female'); // 康熙部首 U+2F25 → NFKC 女
    expect(canonicalGender('Ｍ')).toBe('male'); // 全角
    expect(canonicalGender('♂')).toBe('male');
    expect(canonicalGender('♀')).toBe('female');
    expect(canonicalGender('Femenino')).toBe('female');
    expect(canonicalGender(' 男 ')).toBe('male');
  });

  it('strips a label prefix but keeps its value judgment', () => {
    expect(canonicalGender('性别：男')).toBe('male');
    expect(canonicalGender('Gender: Female')).toBe('female');
    expect(canonicalGender('性别：邱杰')).toBeNull(); // 解析器把姓名塞进了性别
  });

  it('drops everything it cannot prove, instead of failing the write', () => {
    expect(canonicalGender('未知')).toBeNull();
    expect(canonicalGender('保密')).toBeNull();
    expect(canonicalGender('不限')).toBeNull();
    expect(canonicalGender('男 30岁')).toBeNull();
    expect(canonicalGender('')).toBeNull();
    expect(canonicalGender('   ')).toBeNull();
    expect(canonicalGender(null)).toBeNull();
    expect(canonicalGender(undefined)).toBeNull();
    expect(canonicalGender(1)).toBeNull();
    expect(canonicalGender({ gender: '男' })).toBeNull();
  });

  it('only ever returns a value partner Postgres accepts', () => {
    const samples = ['男', '女', 'x', '未知', '♂', 'Femenino', '性别：邱杰', ''];
    for (const s of samples) {
      expect([null, 'male', 'female']).toContain(canonicalGender(s));
    }
  });
});

describe('isDroppedGender', () => {
  it('flags only non-empty values that failed to canonicalize', () => {
    expect(isDroppedGender('未知')).toBe(true);
    expect(isDroppedGender('性别：邱杰')).toBe(true);
    expect(isDroppedGender('男')).toBe(false);
    expect(isDroppedGender('')).toBe(false);
    expect(isDroppedGender('  ')).toBe(false);
    expect(isDroppedGender(null)).toBe(false);
  });
});
