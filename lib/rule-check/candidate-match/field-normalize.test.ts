import { describe, it, expect } from 'vitest';
import {
  normalizePhone,
  normalizeName,
  normalizeEmail,
  normalizeGender,
  normalizeText,
  normalizeGradYear,
  normalizeField,
} from './field-normalize';

describe('normalizePhone', () => {
  it('normalizes mainland +86/0086 variants to the same 11 digits', () => {
    expect(normalizePhone('+86 138 0013 8000')).toBe('13800138000');
    expect(normalizePhone('0086-13800138000')).toBe('13800138000');
  });
  it('rejects malformed, short and placeholder values', () => {
    expect(normalizePhone('086-13800138000')).toBe('');
    expect(normalizePhone('1234567')).toBe('');
    expect(normalizePhone('12')).toBe('');
    expect(normalizePhone('13800138888')).toBe('');
    expect(normalizePhone(null)).toBe('');
  });
  it('international numbers never become identity keys', () => {
    expect(normalizePhone('+65 9123 4567')).toBe('');
  });
});

describe('normalizeName', () => {
  it('collapses internal whitespace and lowercases latin', () => {
    expect(normalizeName('张 三')).toBe('张三');
    expect(normalizeName('  Zhang   San ')).toBe('zhang san');
  });
  it('strips spaces between CJK Extension-A/B chars too (not just BMP)', () => {
    expect(normalizeName('㐀 㐁')).toBe('㐀㐁'); // U+3400, U+3401 (Ext A)
  });
  it('empty for nullish', () => {
    expect(normalizeName(undefined)).toBe('');
  });
});

describe('normalizeEmail', () => {
  it('trims + lowercases', () => {
    expect(normalizeEmail('  Foo@Bar.COM ')).toBe('foo@bar.com');
  });
});

describe('normalizeGender', () => {
  it('canonicalizes male/female variants', () => {
    expect(normalizeGender('男')).toBe('male');
    expect(normalizeGender('M')).toBe('male');
    expect(normalizeGender('Female')).toBe('female');
    expect(normalizeGender('女')).toBe('female');
  });
  it('passes through unknown values normalized', () => {
    expect(normalizeGender(' Other ')).toBe('other');
  });
});

describe('normalizeText (school/major/degree exact fast-path)', () => {
  it('collapses whitespace + lowercases latin but does NOT do semantic mapping', () => {
    expect(normalizeText(' 清华大学 ')).toBe('清华大学');
    // 本科 vs 学士 stay distinct here — semantic equivalence is the AI judge's job.
    expect(normalizeText('本科')).not.toBe(normalizeText('学士'));
    expect(normalizeText('Computer  Science')).toBe('computer science');
  });
});

describe('normalizeGradYear', () => {
  it('extracts the 4-digit year from varied formats', () => {
    expect(normalizeGradYear('2020年6月')).toBe('2020');
    expect(normalizeGradYear('2020-06')).toBe('2020');
    expect(normalizeGradYear('2020届')).toBe('2020');
    expect(normalizeGradYear('no year')).toBe('');
  });
});

describe('normalizeField dispatch', () => {
  it('routes each field to its normalizer', () => {
    expect(normalizeField('phone', '+86 138 0013 8000')).toBe('13800138000');
    expect(normalizeField('name', '张 三')).toBe('张三');
    expect(normalizeField('email', 'A@B.com')).toBe('a@b.com');
    expect(normalizeField('gender', '男')).toBe('male');
    expect(normalizeField('school', ' 清华大学 ')).toBe('清华大学');
    expect(normalizeField('graduationYear', '2020年6月')).toBe('2020');
  });
});
