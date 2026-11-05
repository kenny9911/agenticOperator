import { describe, expect, it } from 'vitest';
import { parseRmhrLockTime } from './lock-time';
import { readResumeDownloadedLockEvidence } from './resume-downloaded-lock';

describe('parseRmhrLockTime', () => {
  it('interprets RMHR naive timestamps as Beijing wall-clock time', () => {
    expect(parseRmhrLockTime('2026-07-14 18:05:33')?.toISOString()).toBe(
      '2026-07-14T10:05:33.000Z',
    );
    expect(parseRmhrLockTime('2026-07-15 00:30:00')?.toISOString()).toBe(
      '2026-07-14T16:30:00.000Z',
    );
  });

  it('keeps timezone-marked timestamps as absolute instants', () => {
    expect(parseRmhrLockTime('2026-07-14T10:05:33Z')?.toISOString()).toBe(
      '2026-07-14T10:05:33.000Z',
    );
    expect(parseRmhrLockTime('2026-07-14T18:05:33+08:00')?.toISOString()).toBe(
      '2026-07-14T10:05:33.000Z',
    );
  });

  it('supports epoch seconds, milliseconds and numeric strings', () => {
    const epochMs = Date.UTC(2026, 6, 14, 10, 5, 33);
    expect(parseRmhrLockTime(epochMs)?.toISOString()).toBe('2026-07-14T10:05:33.000Z');
    expect(parseRmhrLockTime(Math.floor(epochMs / 1000))?.toISOString()).toBe(
      '2026-07-14T10:05:33.000Z',
    );
    expect(parseRmhrLockTime(String(epochMs))?.toISOString()).toBe(
      '2026-07-14T10:05:33.000Z',
    );
  });

  it('returns null for absent or invalid timestamps', () => {
    expect(parseRmhrLockTime(null)).toBeNull();
    expect(parseRmhrLockTime('   ')).toBeNull();
    expect(parseRmhrLockTime('not-a-date')).toBeNull();
  });
});

describe('readResumeDownloadedLockEvidence', () => {
  it('reads snake_case lock fields and keeps received_at as ordering fallback', () => {
    expect(
      readResumeDownloadedLockEvidence({
        locked_by_employee_id: ' EMP-LOCK-HOLDER ',
        locked_at: '2026-07-14 18:05:33',
        received_at: '2026-07-14T10:05:35.000Z',
      }),
    ).toEqual({
      locked_by_employee_id: 'EMP-LOCK-HOLDER',
      locked_at: '2026-07-14 18:05:33',
      lock_observed_at: '2026-07-14T10:05:35.000Z',
    });
  });

  it('accepts camelCase and numeric epoch variants', () => {
    expect(
      readResumeDownloadedLockEvidence({
        lockedByEmployeeId: 'EMP-2',
        lockedAt: 1_784_022_333_000,
        receivedAt: 1_784_022_334_000,
      }),
    ).toEqual({
      locked_by_employee_id: 'EMP-2',
      locked_at: 1_784_022_333_000,
      lock_observed_at: 1_784_022_334_000,
    });
  });

  it('does not turn a missing holder into an unlock command', () => {
    expect(readResumeDownloadedLockEvidence({ employee_id: 'EMP-UPLOADER' })).toEqual({
      locked_by_employee_id: null,
      locked_at: null,
      lock_observed_at: null,
    });
  });
});
