import { describe, it, expect, vi } from 'vitest';

vi.mock('./_helpers', () => ({
  safeWriteInstance: vi.fn().mockResolvedValue({ ok: true, instance: {} }),
  compact: (x: unknown) => x,
  nonEmptyString: (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null),
  asNumberOrNull: (v: unknown) => (typeof v === 'number' ? v : null),
  asIsoDateOrNull: () => null,
}));

import { writeCandidateInstance } from './candidate';

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
});
