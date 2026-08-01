// Candidate-mobile normalization SSOT.
//
// Despite the historical filename, candidate identity no longer uses E.164 or a
// generic international phone parser. The production contract is deliberately
// narrower: only a strong mainland-China mobile (`^1[3-9][0-9]{9}$`) may drive
// candidate deduplication. Common +86 / 0086 / formatting variants collapse to
// the same 11 digits; international, ambiguous, placeholder and malformed values
// are retained only in Resume.raw_parse_result and never become Candidate keys.

type RawPhone = unknown;

export type CandidateMobileStatus =
  | 'valid'
  | 'missing'
  | 'invalid'
  | 'placeholder'
  | 'ambiguous';

export type CandidateMobileResolution = {
  /** Canonical mainland mobile and the sole candidate dedup key. */
  mobile: string | null;
  status: CandidateMobileStatus;
};

export const MAINLAND_MOBILE_RE = /^1[3-9][0-9]{9}$/;

// Repeated defaults/test values become catastrophic once phone is the sole
// identity key. Keep this list explicit and reviewable instead of guessing from
// names or email addresses.
const PLACEHOLDER_MOBILES = new Set([
  '13800138888',
  '13812345678',
]);

const MULTI_VALUE_SEPARATOR_RE = /[,，;；/／、|\n\r]+/;

function isPlaceholderMobile(mobile: string): boolean {
  if (PLACEHOLDER_MOBILES.has(mobile)) return true;
  // Obvious repeated test tails (`13800000000`, `13911111111`, ...). Eight
  // identical trailing digits are strong enough to fail closed for identity use.
  if (/([0-9])\1{7}$/.test(mobile)) return true;
  // Obvious ascending / descending test tails such as 13812345678 and
  // 13987654321. Restrict this heuristic to the last eight digits so ordinary
  // carrier prefixes do not participate in the sequence check.
  const tail = mobile.slice(-8);
  if ('01234567890123456789'.includes(tail)) return true;
  if ('98765432109876543210'.includes(tail)) return true;
  return false;
}

type SingleResolution = {
  mobile: string | null;
  status: Exclude<CandidateMobileStatus, 'missing' | 'ambiguous'>;
};

function normalizeSingle(raw: RawPhone): SingleResolution | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;

  // NFKC converts full-width digits and punctuation before applying the narrow
  // formatting allowance. Letters and other content remain and therefore fail.
  const compact = raw
    .normalize('NFKC')
    .trim()
    .replace(/[\s.\-()]/g, '');

  let mobile: string;
  if (MAINLAND_MOBILE_RE.test(compact)) {
    mobile = compact;
  } else {
    const prefixed = /^(?:\+86|0086|86)(1[3-9][0-9]{9})$/.exec(compact);
    if (!prefixed) return { mobile: null, status: 'invalid' };
    mobile = prefixed[1];
  }

  return isPlaceholderMobile(mobile)
    ? { mobile: null, status: 'placeholder' }
    : { mobile, status: 'valid' };
}

function flattenRawValues(value: RawPhone, out: unknown[]): void {
  if (Array.isArray(value)) {
    for (const item of value) flattenRawValues(item, out);
    return;
  }
  out.push(value);
}

/**
 * Resolve every phone-shaped field returned by RoboHire into one authoritative
 * mainland mobile. Multiple distinct strong numbers are deliberately ambiguous;
 * no "first number wins" rule is allowed.
 */
export function resolveCandidateMobile(rawValues: RawPhone | RawPhone[]): CandidateMobileResolution {
  const flattened: unknown[] = [];
  flattenRawValues(rawValues, flattened);

  const nonEmpty = flattened.filter(
    (value) => typeof value === 'string' && value.trim().length > 0,
  ) as string[];
  if (nonEmpty.length === 0) return { mobile: null, status: 'missing' };

  const valid = new Set<string>();
  let sawPlaceholder = false;
  let sawInvalid = false;
  let sawMultipleValues = false;

  for (const raw of nonEmpty) {
    const parts = raw
      .split(MULTI_VALUE_SEPARATOR_RE)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length > 1) sawMultipleValues = true;

    for (const part of parts.length > 0 ? parts : [raw]) {
      const resolved = normalizeSingle(part);
      if (!resolved || resolved.status === 'invalid') {
        sawInvalid = true;
      } else if (resolved.status === 'placeholder') {
        sawPlaceholder = true;
      } else if (resolved.mobile) {
        valid.add(resolved.mobile);
      }
    }
  }

  if (sawMultipleValues || valid.size > 1) return { mobile: null, status: 'ambiguous' };
  // A valid number alongside any other non-empty unusable value is conflicting
  // contact data, not permission to silently choose the valid-looking field.
  if (valid.size === 1 && (sawInvalid || sawPlaceholder)) {
    return { mobile: null, status: 'ambiguous' };
  }
  if (valid.size === 1) return { mobile: [...valid][0], status: 'valid' };
  if (sawPlaceholder) return { mobile: null, status: 'placeholder' };
  if (sawInvalid) return { mobile: null, status: 'invalid' };
  return { mobile: null, status: 'missing' };
}

/** Canonical key used by partner-pg candidate storage. */
export function dedupKey(raw: RawPhone): string | null {
  return resolveCandidateMobile(raw).mobile;
}

/** Exact phone key used by the audit-only candidate identity rules. */
export function ruleCheckKey(raw: RawPhone): string {
  return dedupKey(raw) ?? '';
}
