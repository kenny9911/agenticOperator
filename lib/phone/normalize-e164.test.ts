import { describe, expect, it } from 'vitest';
import {
  dedupKey,
  MAINLAND_MOBILE_RE,
  resolveCandidateMobile,
  ruleCheckKey,
} from './normalize-e164';

describe('resolveCandidateMobile — mainland 11-digit identity contract', () => {
  it('accepts a strong mainland mobile including the agreed 13800138000 fixture', () => {
    expect(resolveCandidateMobile('13800138000')).toEqual({
      mobile: '13800138000',
      status: 'valid',
    });
    expect(MAINLAND_MOBILE_RE.test('13800138000')).toBe(true);
  });

  it.each([
    '+86 138 0013 8000',
    '0086-138-0013-8000',
    '86 (138) 0013 8000',
    '+86.138.0013.8000',
    '＋８６ １３８－００１３－８０００',
  ])('normalizes %s to the same 11 digits', (raw) => {
    expect(resolveCandidateMobile(raw)).toEqual({
      mobile: '13800138000',
      status: 'valid',
    });
  });

  it.each([
    '+65 9123 4567',
    '00852 6123 4567',
    '12',
    '010-88886666',
    'phone unavailable',
  ])('rejects international, landline or malformed input: %s', (raw) => {
    expect(resolveCandidateMobile(raw)).toEqual({ mobile: null, status: 'invalid' });
  });

  it.each([
    '13800138888',
    '13812345678',
    '18888888888',
    '13800000000',
    '13987654321',
  ])('rejects an explicit/repeated/sequential placeholder: %s', (raw) => {
    expect(resolveCandidateMobile(raw)).toEqual({ mobile: null, status: 'placeholder' });
  });

  it('returns missing for blank/null input', () => {
    expect(resolveCandidateMobile([null, undefined, '  '])).toEqual({
      mobile: null,
      status: 'missing',
    });
  });

  it('accepts duplicate aliases only when they normalize to the same number', () => {
    expect(resolveCandidateMobile(['13800138000', '+86 138-0013-8000'])).toEqual({
      mobile: '13800138000',
      status: 'valid',
    });
  });

  it.each([
    [['13800138000 / 13900139000']],
    [['13800138000', '13900139000']],
    [['13800138000', '+65 9123 4567']],
    [['13800138000', 'not-a-phone']],
    [['13800138000', '13800138888']],
  ])('never chooses one value from conflicting non-empty inputs: %j', (values) => {
    expect(resolveCandidateMobile(values)).toEqual({ mobile: null, status: 'ambiguous' });
  });
});

describe('storage/audit aliases', () => {
  it('use the exact same mainland key', () => {
    expect(dedupKey('+86 138-0013-8000')).toBe('13800138000');
    expect(ruleCheckKey('0086 13800138000')).toBe('13800138000');
    expect(dedupKey('+65 9123 4567')).toBeNull();
    expect(ruleCheckKey('+65 9123 4567')).toBe('');
  });
});
