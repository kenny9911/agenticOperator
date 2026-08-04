import { describe, expect, it } from 'vitest';
import {
  parseResumeProcessingContract,
  validateResumeProcessingContract,
} from './resume-processing-contract';

describe('resume processing contract', () => {
  it('keeps legacy events readable when the contract is completely absent', () => {
    expect(parseResumeProcessingContract({ operator_id: 'EMP-LEGACY' })).toBeNull();
  });

  it('accepts and normalizes the rmhr_deferred v2 contract', () => {
    expect(
      parseResumeProcessingContract({
        contract_version: 2,
        processing_mode: 'rmhr_deferred',
        processing_reason: 'rmhr_email_not_found',
        operator_id: ' EMP-OPERATOR ',
      }),
    ).toEqual({
      contract_version: 2,
      processing_mode: 'rmhr_deferred',
      processing_reason: 'rmhr_email_not_found',
      operator_id: 'EMP-OPERATOR',
    });
  });

  it('rejects deferred contracts without v2, the exact reason, or operator scope', () => {
    const issues = validateResumeProcessingContract({
      contract_version: 1,
      processing_mode: 'rmhr_deferred',
      processing_reason: 'email_not_found',
      operator_id: null,
    });
    expect(issues.map((issue) => issue.path).sort()).toEqual([
      'contract_version',
      'operator_id',
      'processing_reason',
    ]);
  });
});
