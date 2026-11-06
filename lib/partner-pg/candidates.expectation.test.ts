import { beforeEach, describe, expect, it, vi } from 'vitest';

const queries: Array<{ text: string; params: unknown[] }> = [];
let linkedExpectationIds: string[] = [];

vi.mock('./client', () => ({
  withTx: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    const client = {
      query: vi.fn(async (text: string, params: unknown[] = []) => {
        queries.push({ text, params });
        if (/SELECT candidate_expectation_id[\s\S]+FROM candidate/i.test(text)) {
          return { rows: [{ candidate_expectation_id: linkedExpectationIds }] };
        }
        return { rows: [] };
      }),
    };
    return fn(client);
  }),
  query: vi.fn(async () => ({ rows: [] })),
}));

import { saveCandidateToPartnerPg } from './candidates';

beforeEach(() => {
  queries.length = 0;
  linkedExpectationIds = [];
});

const baseInput = {
  upload_id: 'up-expectation',
  bucket: 'recruit-resume-raw',
  object_key: 'resumes/expectation.pdf',
  candidate_id: 'candidate-1',
  parsed: { data: { name: '张三' } },
};

function expectationUpsert() {
  return queries.find((query) => /INSERT INTO candidate_expectation/i.test(query.text));
}

function expectationLinkUpdate() {
  return queries.find((query) =>
    /candidate_expectation_id\s*=\s*ARRAY\[\$2\]::text\[\]/i.test(query.text),
  );
}

describe('saveCandidateToPartnerPg — candidate expectation', () => {
  it('updates the first linked expectation id and only supplied fields', async () => {
    linkedExpectationIds = ['expectation-existing'];

    const result = await saveCandidateToPartnerPg({
      ...baseInput,
      expectation_payload: {
        expected_position: '电气工程师',
        expected_salary_range: '13000-15000',
      },
    });

    const upsert = expectationUpsert();
    expect(upsert).toBeTruthy();
    expect(upsert!.text).toContain('ON CONFLICT (candidate_expectation_id) DO UPDATE');
    expect(upsert!.text).toContain('expected_position = EXCLUDED.expected_position');
    expect(upsert!.text).toContain('expected_salary_range = EXCLUDED.expected_salary_range');
    expect(upsert!.text).not.toContain('expected_industry = EXCLUDED.expected_industry');
    expect(upsert!.params).toEqual([
      'expectation-existing',
      'candidate-1',
      '电气工程师',
      '13000-15000',
    ]);
    expect(expectationLinkUpdate()).toBeUndefined();
    expect(result.candidate_expectation_id).toBe('expectation-existing');
  });

  it('creates and links an expectation when the candidate has none', async () => {
    const result = await saveCandidateToPartnerPg({
      ...baseInput,
      expectation_payload: {
        expected_location: ' 南京 ',
        constraints: [],
      },
    });

    const upsert = expectationUpsert();
    const link = expectationLinkUpdate();
    expect(upsert).toBeTruthy();
    expect(link).toBeTruthy();
    expect(result.candidate_expectation_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(upsert!.params).toEqual([
      result.candidate_expectation_id,
      'candidate-1',
      '南京',
      [],
    ]);
    expect(link!.params).toEqual([
      'candidate-1',
      result.candidate_expectation_id,
    ]);
  });

  it('does not touch candidate_expectation when the event has no usable payload', async () => {
    const result = await saveCandidateToPartnerPg({
      ...baseInput,
      expectation_payload: null,
    });

    expect(expectationUpsert()).toBeUndefined();
    expect(expectationLinkUpdate()).toBeUndefined();
    expect(result.candidate_expectation_id).toBeNull();
  });
});
