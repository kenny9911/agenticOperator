import { describe, expect, it } from 'vitest';
import { summarizeLogValue } from './log-value-summary';

describe('summarizeLogValue', () => {
  it('keeps shape and sizes without retaining literal PII', () => {
    const summary = summarizeLogValue({
      entityType: 'Candidate',
      instances: [{ name: '张三', phone: '13800138000', email: 'z@example.com' }],
    });
    const serialized = JSON.stringify(summary);

    expect(serialized).toContain('entityType');
    expect(serialized).toContain('instances');
    expect(serialized).not.toContain('Candidate');
    expect(serialized).not.toContain('张三');
    expect(serialized).not.toContain('13800138000');
    expect(serialized).not.toContain('z@example.com');
  });

  it('summarizes SQL parameters and binary values without their contents', () => {
    const summary = summarizeLogValue(['人工姓名', '13800138000', Buffer.from('resume')]);
    const serialized = JSON.stringify(summary);

    expect(serialized).toContain('byte_length');
    expect(serialized).not.toContain('人工姓名');
    expect(serialized).not.toContain('13800138000');
    expect(serialized).not.toContain('resume');
  });
});
