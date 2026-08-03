import { beforeEach, describe, it, expect, vi } from 'vitest';

const { safeWriteInstance } = vi.hoisted(() => ({
  safeWriteInstance: vi.fn().mockResolvedValue({ ok: true, instance: {} }),
}));

vi.mock('./_helpers', () => ({
  safeWriteInstance,
  compact: (x: unknown) => x,
  nonEmptyString: (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null),
  asNumberOrNull: (v: unknown) => (typeof v === 'number' ? v : null),
  asIsoDateOrNull: (v: unknown) => {
    if (v instanceof Date) return v.toISOString();
    if (typeof v !== 'string' || !v.trim()) return null;
    const parsed = new Date(v);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  },
}));

import { writeCandidateInstance } from './candidate';

beforeEach(() => safeWriteInstance.mockClear());

describe('writeCandidateInstance', () => {
  it('flags nameWasPlaceholder=false when parser provided a name', async () => {
    const r = await writeCandidateInstance({ candidate_id: 'C1', parsed: { name: '张三' } });
    expect(r.ok).toBe(true);
    expect(r.nameWasPlaceholder).toBe(false);
    expect(r.parsedNameRaw).toBe('张三');
  });
  it('flags nameWasPlaceholder=true when parser had no name', async () => {
    const r = await writeCandidateInstance({ candidate_id: 'C2', parsed: {} });
    expect(r.ok).toBe(true);
    expect(r.nameWasPlaceholder).toBe(true);
    expect(r.parsedNameRaw).toBeNull();
  });
  it('flags nameWasPlaceholder=true when parser name was whitespace', async () => {
    const r = await writeCandidateInstance({ candidate_id: 'C3', parsed: { name: '   ' } });
    expect(r.ok).toBe(true);
    expect(r.nameWasPlaceholder).toBe(true);
    expect(r.parsedNameRaw).toBe('   ');
  });

  it('writes the exact normalized phone returned by partner-pg, not raw RoboHire contact', async () => {
    await writeCandidateInstance({
      candidate_id: 'C4',
      normalized_phone: '13800138000',
      parsed: { name: '张三', phone: '+86 138-0013-8000' },
    });
    expect(safeWriteInstance).toHaveBeenCalledWith(
      'Candidate',
      expect.objectContaining({ phone: '13800138000' }),
    );
  });

  it('does not write raw phone when partner-pg found no strong mobile', async () => {
    await writeCandidateInstance({
      candidate_id: 'C5',
      normalized_phone: null,
      parsed: { name: 'Alex', phone: '+65 9123 4567' },
    });
    expect(safeWriteInstance).toHaveBeenCalledWith(
      'Candidate',
      expect.objectContaining({ phone: null }),
    );
  });

  it('mirrors the persisted phone-hit snapshot instead of conflicting parser identity', async () => {
    await writeCandidateInstance({
      candidate_id: 'C6',
      employee_id: 'incoming-owner',
      normalized_phone: '13800138000',
      parsed: {
        name: '李四',
        phone: '13800138000',
        email: 'new@example.com',
      },
      persisted_candidate: {
        name: '张三',
        mobile: '13800138000',
        mobile_normalized: '13800138000',
        email: 'stored@example.com',
        gender: '男',
        birth_date: null,
        current_location: '上海',
        highest_acquired_degree: '本科',
        work_years: 8,
        employee_id: 'stored-owner',
      },
    });

    expect(safeWriteInstance).toHaveBeenCalledWith(
      'Candidate',
      expect.objectContaining({
        name: '张三',
        phone: '13800138000',
        email: 'stored@example.com',
        employee_id: 'stored-owner',
        address: '上海',
        highest_acquired_degree: '本科',
        work_years: 8,
      }),
    );
  });

  it('mirrors the exact Partner PG lock tuple', async () => {
    await writeCandidateInstance({
      candidate_id: 'C7',
      employee_id: 'EMP-LOCK-HOLDER',
      is_locked: true,
      lock_start_time: new Date('2026-07-14T10:05:33.000Z'),
      parsed: { name: '测试候选人', phone: '13800138000' },
    });

    expect(safeWriteInstance).toHaveBeenCalledWith(
      'Candidate',
      expect.objectContaining({
        employee_id: 'EMP-LOCK-HOLDER',
        is_locked: true,
        lock_start_time: '2026-07-14T10:05:33.000Z',
      }),
    );
  });

  it('mirrors an unlocked public-pool tuple without falling back to uploader', async () => {
    await writeCandidateInstance({
      candidate_id: 'C8',
      employee_id: null,
      is_locked: false,
      lock_start_time: null,
      parsed: { name: '测试候选人' },
    });

    expect(safeWriteInstance).toHaveBeenCalledWith(
      'Candidate',
      expect.objectContaining({
        employee_id: null,
        is_locked: false,
        lock_start_time: null,
      }),
    );
  });
});
