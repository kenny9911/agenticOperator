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
  it('strips non-digits and takes the last 11 for 11+ digit numbers', () => {
    expect(normalizePhone('+86 138 0013 8000')).toBe('13800138000');
    expect(normalizePhone('086-13800138000')).toBe('13800138000');
  });
  it('keeps short digit strings as-is (>=7), drops too-short', () => {
    expect(normalizePhone('1234567')).toBe('1234567');
    expect(normalizePhone('12')).toBe('');
    expect(normalizePhone(null)).toBe('');
  });
  it('international number → correct national number, not last-11-of-raw (anti 假并/假拆)', () => {
    // Old China-only heuristic returned '6591234567' (wrongly kept the +65 country
    // code in the suffix key); the shared normalizer gives the true national number.
    expect(normalizePhone('+65 9123 4567')).toBe('91234567');
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
