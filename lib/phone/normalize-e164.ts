// lib/phone/normalize-e164.ts
//
// SINGLE home for candidate phone-number normalization. Before this module the
// codebase had two divergent China-only "strip non-digits (+ maybe last 11)"
// heuristics — `normalizePhone` (rule-check exact/fuzzy prefilter) and
// `normalizeMobile` (partner-pg dedup + the stored `mobile_normalized` column).
// International numbers 假并/假拆 (a +86 number and a foreign number sharing a
// digit suffix collapse; one person written two ways splits).
//
// This module unifies them and adds a real E.164 canonicalizer
// (libphonenumber-js — offline, deterministic, per-country trunk/length rules):
//
//   • toE164()        — E.164 canonical form (`+8613800138000`), the correct
//                       globally-unique key. Exposed for the (deferred) shared-DB
//                       `mobile_e164` column and for display; NOT yet the stored
//                       dedup key (see below).
//   • nationalDigits()— national significant number of a VALID parse (country code
//                       dropped) — e.g. `+65 9123 4567` → `91234567`, the fix the
//                       old last-11 heuristic got wrong.
//   • legacyDigits()  — the raw digit strip (unchanged heuristic base).
//   • dedupKey()      — the partner-pg WRITE key. Deliberately kept **byte-identical
//                       to the pre-refactor `normalizeMobile`** (pure legacy digits):
//                       the key is matched as a suffix `LIKE '%digits'` against the
//                       raw `mobile` column AND lives in the partner DB shared with
//                       the live RAAS system, so its FORMAT cannot change without a
//                       coordinated column migration (deferred — see the 2026-07-21
//                       old-repo optimization design, §3). Zero online risk.
//   • ruleCheckKey()  — the rule-check IN-MEMORY prefilter key. Safe to upgrade
//                       (transient; the prefilter is a documented superset), so it
//                       uses libphonenumber's national number when parseable and
//                       falls back to the legacy heuristic otherwise. CN output is
//                       byte-identical to the old normalizePhone; international is
//                       corrected.

import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

export type PhoneRegion = CountryCode;

/** Default region used to resolve a bare national number. CN because this is a
 *  China-first recruitment flow; we NEVER blindly prepend +86 — a number only
 *  becomes CN when libphonenumber validly parses it as such. */
const DEFAULT_REGION: CountryCode = 'CN';

type RawPhone = string | null | undefined;

function parse(raw: RawPhone, region: CountryCode) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    return parsePhoneNumberFromString(raw, region) ?? null;
  } catch {
    return null;
  }
}

/** E.164 canonical form (`+8613800138000`) for a valid number, else null. */
export function toE164(raw: RawPhone, region: CountryCode = DEFAULT_REGION): string | null {
  const p = parse(raw, region);
  return p && p.isValid() ? p.number : null;
}

/** National significant number (digits, country code dropped) for a VALID parse,
 *  else null. `+65 9123 4567` → `91234567`. */
export function nationalDigits(
  raw: RawPhone,
  region: CountryCode = DEFAULT_REGION,
): string | null {
  const p = parse(raw, region);
  if (!p || !p.isValid()) return null;
  const n = String(p.nationalNumber ?? '').replace(/\D/g, '');
  return n || null;
}

/** Raw digit strip — the pre-existing heuristic base, kept verbatim. */
export function legacyDigits(raw: RawPhone): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\D/g, '');
}

export type DedupKeyOptions = {
  /** DEDUP_PHONE_PRIMARY semantics: require >= 11 digits and take the LAST 11
   *  (collapse country-code / OCR variants), else null. */
  phonePrimary?: boolean;
};

/**
 * Partner-pg dedup / `mobile_normalized` write key.
 *
 * ⚠️ Byte-identical to the legacy `normalizeMobile` on purpose — the stored value
 * is co-owned with the live RAAS system and matched via suffix LIKE, so its format
 * must not drift without a coordinated migration. libphonenumber intentionally does
 * NOT influence this key. (E.164 upgrade of the stored column is the deferred §3.)
 */
export function dedupKey(raw: RawPhone, opts: DedupKeyOptions = {}): string | null {
  const digits = legacyDigits(raw);
  if (opts.phonePrimary) {
    return digits.length >= 11 ? digits.slice(-11) : null;
  }
  return digits.length >= 7 ? digits : null;
}

/**
 * Rule-check in-memory prefilter/exact key. Uses libphonenumber's national number
 * when the input parses to a valid number (correct for international), otherwise the
 * legacy digit heuristic. Output shape matches the old normalizePhone: '' for
 * < 7 digits, last 11 for >= 11, else the digits as-is. For China numbers this is
 * byte-identical to the old behavior (country code 86 drops out either way).
 */
export function ruleCheckKey(raw: RawPhone, region: CountryCode = DEFAULT_REGION): string {
  const digits = nationalDigits(raw, region) ?? legacyDigits(raw);
  if (digits.length < 7) return '';
  return digits.length >= 11 ? digits.slice(-11) : digits;
}
