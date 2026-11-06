import { describe, it, expect } from 'vitest';
import {
  toE164,
  nationalDigits,
  legacyDigits,
  dedupKey,
  ruleCheckKey,
} from './normalize-e164';

describe('toE164 — E.164 canonical form (libphonenumber-js)', () => {
  it('canonicalizes a formatted China mobile', () => {
    expect(toE164('+86 138 0013 8000')).toBe('+8613800138000');
  });
  it('applies the default region (CN) to a bare national number', () => {
    expect(toE164('13800138000', 'CN')).toBe('+8613800138000');
  });
  it('keeps a foreign number in its own country (no blind +86)', () => {
    expect(toE164('+65 9123 4567')).toBe('+6591234567');
  });
  it('returns null for an invalid / unparseable number', () => {
    expect(toE164('086-13800138000', 'CN')).toBeNull(); // 086 prefix → invalid
    expect(toE164('12', 'CN')).toBeNull();
    expect(toE164(null)).toBeNull();
  });
  it('country code makes same-suffix numbers distinct (anti 假并)', () => {
    // A China number and a foreign number that share trailing digits must NOT
    // collapse to the same canonical form.
    expect(toE164('+8613800138000')).not.toBe(toE164('+6613800138000'));
  });
});

describe('nationalDigits — national significant number for a VALID parse', () => {
  it('drops the country code for a valid China mobile', () => {
    expect(nationalDigits('+86 138 0013 8000')).toBe('13800138000');
  });
  it('gives the correct national number for a foreign number (not last-11 of raw)', () => {
    expect(nationalDigits('+65 9123 4567')).toBe('91234567');
  });
  it('returns null when the number cannot be validly parsed', () => {
    expect(nationalDigits('086-13800138000', 'CN')).toBeNull();
    expect(nationalDigits('not a phone')).toBeNull();
    expect(nationalDigits(null)).toBeNull();
  });
});

describe('legacyDigits — raw digit strip (the pre-existing heuristic base)', () => {
  it('keeps every digit, no shaping', () => {
    expect(legacyDigits('+86 138 0013 8000')).toBe('8613800138000');
    expect(legacyDigits('086-13800138000')).toBe('08613800138000');
  });
  it('empty for nullish / non-digit', () => {
    expect(legacyDigits(null)).toBe('');
    expect(legacyDigits('abc')).toBe('');
  });
});

describe('dedupKey — partner-pg write key MUST stay byte-identical to legacy normalizeMobile', () => {
  // Legacy normalizeMobile (lib/partner-pg/candidates.ts, pre-refactor):
  //   digits = raw.replace(/\D/g,'')
  //   phonePrimary: digits.length >= 11 ? digits.slice(-11) : null
  //   else:         digits.length >= 7  ? digits          : null
  describe('flag OFF (legacy default — all digits kept)', () => {
    it('keeps all digits (INCLUDING country code) for >= 7', () => {
      expect(dedupKey('+86 138 0013 8000')).toBe('8613800138000');
    });
    it('keeps a short >=7 number as-is', () => {
      expect(dedupKey('1234567')).toBe('1234567');
    });
    it('null below 7 digits', () => {
      expect(dedupKey('12')).toBeNull();
      expect(dedupKey(null)).toBeNull();
    });
  });
  describe('flag ON (DEDUP_PHONE_PRIMARY — last 11)', () => {
    it('takes the last 11 digits', () => {
      expect(dedupKey('+86 138 0013 8000', { phonePrimary: true })).toBe('13800138000');
    });
    it('null below 11 digits', () => {
      expect(dedupKey('1234567', { phonePrimary: true })).toBeNull();
      expect(dedupKey('12', { phonePrimary: true })).toBeNull();
    });
  });
});

describe('ruleCheckKey — rule-check in-memory key (CN identical, international fixed)', () => {
  it('matches the legacy normalizePhone output for China numbers', () => {
    expect(ruleCheckKey('+86 138 0013 8000')).toBe('13800138000');
    expect(ruleCheckKey('086-13800138000')).toBe('13800138000'); // via heuristic fallback
  });
  it('keeps short digit strings (>=7), drops too-short', () => {
    expect(ruleCheckKey('1234567')).toBe('1234567');
    expect(ruleCheckKey('12')).toBe('');
    expect(ruleCheckKey(null)).toBe('');
  });
  it('THE FIX: an international number yields its correct national number, not last-11-of-raw', () => {
    // Old China-only heuristic would have returned '6591234567' (last 11 of raw digits,
    // wrongly keeping the country code). libphonenumber gives the true national number.
    expect(ruleCheckKey('+65 9123 4567')).toBe('91234567');
  });
});
