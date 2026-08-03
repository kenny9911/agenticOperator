// RMHR lockTime parsing parity with RAAS ADR-0057.
//
// RMHR's common `yyyy-MM-dd HH:mm:ss` value is a Beijing wall clock without
// a timezone marker. Parsing it with `new Date(raw)` would therefore depend on
// the AO process timezone and shifts every lock by +8h in the UTC container.

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const HAS_TZ_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const NAIVE_DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/;
const EPOCH_RE = /^\d{10,}$/;

/** Parse an RMHR lock timestamp into an absolute instant. Invalid values fail closed. */
export function parseRmhrLockTime(
  raw: string | number | null | undefined,
): Date | null {
  if (raw == null || raw === '') return null;

  if (typeof raw === 'number') {
    const parsed = new Date(raw < 1e12 ? raw * 1000 : raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const value = raw.trim();
  if (!value) return null;

  if (EPOCH_RE.test(value)) {
    const epoch = Number(value);
    const parsed = new Date(epoch < 1e12 ? epoch * 1000 : epoch);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  if (HAS_TZ_RE.test(value)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const match = NAIVE_DATETIME_RE.exec(value);
  if (match) {
    const [, year, month, day, hour, minute, second, millisecond] = match;
    const wallClockMs = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      second ? Number(second) : 0,
      millisecond ? Number(millisecond.padEnd(3, '0')) : 0,
    );
    if (Number.isNaN(wallClockMs)) return null;
    return new Date(wallClockMs - BEIJING_OFFSET_MS);
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
