import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./client', () => ({ query: vi.fn() }));

import { query } from './client';
import { getRequirementDetailByJobPostingId } from './requirements';

const mockQuery = query as ReturnType<typeof vi.fn>;

beforeEach(() => vi.clearAllMocks());

describe('getRequirementDetailByJobPostingId', () => {
  it('resolves the posting anchor and keeps the posting id on the hydrated JR', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          job_posting_id: 'JP-1',
          requirement_json: { job_requisition_id: 'JR-1', client_id: 'CLI-1' },
          specification_json: { job_requisition_specification_id: 'SPEC-1' },
        },
      ],
    });

    await expect(getRequirementDetailByJobPostingId('JP-1')).resolves.toMatchObject({
      job_posting_id: 'JP-1',
      job_requisition_id: 'JR-1',
      client_id: 'CLI-1',
      specification: { job_requisition_specification_id: 'SPEC-1' },
    });
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('WHERE p.job_posting_id = $1'), [
      'JP-1',
    ]);
  });
});
