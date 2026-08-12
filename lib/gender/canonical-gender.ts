// Candidate-gender canonicalization SSOT.
//
// Partner Postgres constrains the column to exactly three values:
//   ALTER TABLE candidate ADD CONSTRAINT candidate_gender_canonical_check
//     CHECK (gender IS NULL OR gender = ANY (ARRAY['male', 'female']));
//
// RoboHire's parse output is free text lifted off the résumé itself, so it
// arrives as '男' / '女' and — in the tail — as label noise ('性别：邱杰'),
// Kangxi radicals ('⼥'), symbols ('♂') and other languages ('Femenino').
// Writing any of those straight through aborts the whole ingest transaction,
// so one unparseable gender string costs the entire Candidate + Resume.
//
// Contract: map the known synonyms, drop everything else to null. Dropping is
// lossless for the pipeline — resume.raw_parse_result keeps the full parser
// object, and gender is never an identity or dedup key.

export type CanonicalGender = 'male' | 'female';

// Explicit and reviewable, same policy as PLACEHOLDER_MOBILES in
// lib/phone/normalize-e164.ts: extend the list when a new real value shows up
// in resume.raw_parse_result, never widen with a fuzzy match.
const MALE_TOKENS = new Set([
  '男', '男性', '男生', '男士', '先生',
  'm', 'male', 'man', 'boy',
  'masculino', 'masculin',
  '♂',
]);

const FEMALE_TOKENS = new Set([
  '女', '女性', '女生', '女士',
  'f', 'female', 'woman', 'girl',
  'femenino', 'feminino', 'feminin', 'féminin',
  '♀',
]);

/** '性别：男' / 'Gender: male' — the label is noise, the tail may be a value. */
const LABEL_PREFIX_RE = /^(性别|gender|sex)[\p{P}]*/u;

// NFKC folds Kangxi radicals ('⼥' U+2F25 → '女') and full-width latin; stripping
// whitespace catches '男 性'. Punctuation is deliberately NOT stripped here —
// '♂' / '♀' are symbols and must survive.
function fold(raw: string): string {
  return raw.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
}

function lookup(token: string): CanonicalGender | null {
  if (MALE_TOKENS.has(token)) return 'male';
  if (FEMALE_TOKENS.has(token)) return 'female';
  return null;
}

/**
 * Canonicalize an arbitrary parser value to what partner Postgres accepts.
 * Anything unrecognized — junk, free text, '未知', non-strings — becomes null.
 */
export function canonicalGender(raw: unknown): CanonicalGender | null {
  if (typeof raw !== 'string') return null;
  const folded = fold(raw);
  if (!folded) return null;

  const direct = lookup(folded);
  if (direct) return direct;

  const unlabeled = folded.replace(LABEL_PREFIX_RE, '');
  return unlabeled && unlabeled !== folded ? lookup(unlabeled) : null;
}

/** True when the parser sent something non-empty that we had to drop. Callers
 *  use it to log the dropped value instead of silently losing the signal. */
export function isDroppedGender(raw: unknown): boolean {
  return typeof raw === 'string' && fold(raw) !== '' && canonicalGender(raw) === null;
}
