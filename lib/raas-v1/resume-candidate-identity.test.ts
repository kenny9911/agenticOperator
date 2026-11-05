import { describe, expect, it } from 'vitest';
import {
  readRmhrManualCandidateIdentity,
  redactResumeDownloadedIdentityForLog,
} from './resume-candidate-identity';

describe('RMHR manual Candidate identity', () => {
  it('requires the explicit source marker and trims the accepted fields', () => {
    expect(
      readRmhrManualCandidateIdentity({
        candidate_name: ' 张三 ',
        candidate_phone: ' 13800138000 ',
      }),
    ).toBeNull();
    expect(
      readRmhrManualCandidateIdentity({
        candidate_identity_source: 'rmhr_manual_refill',
        candidate_name: ' 张三 ',
        candidate_phone: ' 13800138000 ',
      }),
    ).toEqual({
      source: 'rmhr_manual_refill',
      name: '张三',
      phone: '13800138000',
    });
  });

  it('redacts identity in canonical-envelope log copies', () => {
    expect(
      redactResumeDownloadedIdentityForLog({
        payload: {
          upload_id: 'UP-1',
          candidate_name: '张三',
          candidate_phone: '13800138000',
          parsed: { data: { name: '张三', phone: '13800138000', rawText: 'safe' } },
        },
      }),
    ).toEqual({
      payload: {
        upload_id: 'UP-1',
        candidate_name: '[REDACTED]',
        candidate_phone: '[REDACTED]',
        parsed: {
          data: { name: '[REDACTED]', phone: '[REDACTED]', rawText: 'safe' },
        },
      },
    });
  });

  it.each([
    { parsed: { name: '张三', phone: '13800138000', rawText: 'safe' } },
    { parsed_data: { name: '张三', mobile: '13800138000', rawText: 'safe' } },
    { parser: { data: { name: '张三', phoneNumber: '13800138000', rawText: 'safe' } } },
  ])('redacts identity in every legacy parsed shape', (shape) => {
    const redacted = redactResumeDownloadedIdentityForLog(shape) as Record<string, any>;
    const data = redacted.parsed ?? redacted.parsed_data ?? redacted.parser?.data;
    expect(data.name).toBe('[REDACTED]');
    expect(data.phone ?? data.mobile ?? data.phoneNumber).toBe('[REDACTED]');
    expect(data.rawText).toBe('safe');
  });
});
