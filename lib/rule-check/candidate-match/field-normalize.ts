// Deterministic field normalization for the exact-match fast path. These canonicalize
// surface noise (whitespace, case, formatting) ONLY — they deliberately do NOT do
// semantic mapping (本科 → 学士, 清华 → 清华大学). Semantic equivalence is the AI
// judge's job (ai-equivalence.ts); keeping normalize conservative means the exact path
// never silently merges two genuinely-different values.

import type { MatchField } from './rules-data';
import { ruleCheckKey } from '@/lib/phone/normalize-e164';
import { canonicalGender } from '@/lib/gender/canonical-gender';

const s = (raw: string | null | undefined): string => (raw ?? '').trim();

/** Canonical identity key: one non-placeholder mainland-China 11-digit mobile.
 *  International, malformed and ambiguous values return ''. */
export function normalizePhone(raw: string | null | undefined): string {
  return ruleCheckKey(raw);
}

/** Collapse internal whitespace + lowercase latin, then drop spaces adjacent to CJK
 *  ("张 三" → "张三") while keeping latin word spaces ("Zhang San" → "zhang san"). */
export function normalizeName(raw: string | null | undefined): string {
  return s(raw)
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/\s*(\p{Script=Han})\s*/gu, '$1');
}

export function normalizeEmail(raw: string | null | undefined): string {
  return s(raw).toLowerCase();
}

/** Canonicalize common male/female spellings; otherwise pass through normalized.
 *  Shares the mapping table with the DB writers (lib/gender/canonical-gender.ts)
 *  so matching and persistence can never disagree on what '男' means. */
export function normalizeGender(raw: string | null | undefined): string {
  return canonicalGender(raw) ?? s(raw).toLowerCase();
}

/** Generic text canonicalization for school / major / degree. Collapses whitespace
 *  and lowercases latin; no semantic mapping. */
export function normalizeText(raw: string | null | undefined): string {
  return s(raw).replace(/\s+/g, ' ').toLowerCase();
}

/** Extract the 4-digit graduation year from varied formats (2020年6月, 2020-06,
 *  2020届). Returns '' when no plausible year is present. */
export function normalizeGradYear(raw: string | null | undefined): string {
  const m = s(raw).match(/(19|20)\d{2}/);
  return m ? m[0] : '';
}

/** Route a field to its normalizer. */
export function normalizeField(field: MatchField, raw: string | null | undefined): string {
  switch (field) {
    case 'phone':
      return normalizePhone(raw);
    case 'name':
      return normalizeName(raw);
    case 'email':
      return normalizeEmail(raw);
    case 'gender':
      return normalizeGender(raw);
    case 'graduationYear':
      return normalizeGradYear(raw);
    case 'school':
    case 'major':
    case 'degree':
      return normalizeText(raw);
  }
}
