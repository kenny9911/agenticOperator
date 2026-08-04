// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient, QueryResult } from 'pg';

const mocks = vi.hoisted(() => ({
  withTx: vi.fn(),
}));

vi.mock('./client', () => ({
  withTx: mocks.withTx,
}));

import { syncJdToPartnerPg, type SyncJdInput } from './job-posting';

type QueryCall = { text: string; params?: unknown[] };

function baseInput(overrides: Partial<SyncJdInput> = {}): SyncJdInput {
  return {
    job_requisition_id: 'JR-OUTBOX-1',
    client_id: 'CLIENT-1',
    title: '智能硬件项目经理',
    description: '负责智能硬件项目全生命周期交付。',
    jd_generated_outbox: {
      source_event_id: 'source-event-1',
      jd_content: '# 智能硬件项目经理\n\n负责智能硬件项目全生命周期交付。',
      source_action: 'createJD',
      trace: {
        trace_id: 'trace-1',
        request_id: 'request-1',
        workflow_id: 'workflow-1',
        parent_trace_id: 'parent-1',
      },
    },
    ...overrides,
  };
}

function existingPosting(
  overrides: Partial<{
    job_posting_id: string;
    status: string | null;
    publish_status: string | null;
    closed_at: string | null;
  }> = {},
) {
  return {
    job_posting_id: 'JP-OUTBOX-1',
    status: 'draft',
    publish_status: 'pending',
    closed_at: null,
    ...overrides,
  };
}

function installTransaction(
  onQuery: (call: QueryCall, calls: QueryCall[]) => Promise<Record<string, unknown>>,
) {
  const calls: QueryCall[] = [];
  const query = vi.fn(async (text: string, params?: unknown[]) => {
    const call = { text, params };
    calls.push(call);
    return onQuery(call, calls) as unknown as QueryResult;
  });
  mocks.withTx.mockImplementation(async (fn: (client: PoolClient) => Promise<unknown>) =>
    fn({ query } as unknown as PoolClient),
  );
  return { calls, query };
}

function standardQueryHandler(options: {
  posting?: ReturnType<typeof existingPosting>;
  insertedEventId?: string | null;
  replayRow?: Record<string, unknown> | null;
  outboxError?: Error;
} = {}) {
  const posting = options.posting ?? existingPosting();
  return async ({ text }: QueryCall): Promise<Record<string, unknown>> => {
    if (/pg_advisory_xact_lock/i.test(text)) return { rows: [], rowCount: 1 };
    if (/FROM job_posting/i.test(text)) return { rows: [posting], rowCount: 1 };
    if (/INSERT INTO event_outbox/i.test(text)) {
      if (options.outboxError) throw options.outboxError;
      const eventId = options.insertedEventId === undefined ? 'JD-EVENT-1' : options.insertedEventId;
      return { rows: eventId ? [{ event_id: eventId }] : [], rowCount: eventId ? 1 : 0 };
    }
    if (/FROM event_outbox/i.test(text)) {
      return {
        rows: options.replayRow ? [options.replayRow] : [],
        rowCount: options.replayRow ? 1 : 0,
      };
    }
    return { rows: [], rowCount: 1 };
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('syncJdToPartnerPg — transactional JD_GENERATED outbox', () => {
  it('writes the advisory lock, JobPosting and canonical outbox in one strict transaction', async () => {
    const { calls } = installTransaction(standardQueryHandler());

    const result = await syncJdToPartnerPg(baseInput());

    expect(result).toEqual({
      synced: true,
      job_posting_id: 'JP-OUTBOX-1',
      job_requisition_id: 'JR-OUTBOX-1',
      jd_generated_event_id: 'JD-EVENT-1',
      jd_generated_idempotency_key:
        'JD_GENERATED:createJD:JR-OUTBOX-1:source-event-1',
    });
    expect(mocks.withTx).toHaveBeenCalledWith(
      expect.any(Function),
      { allowMirrorFallback: false },
    );

    const lockIndex = calls.findIndex((call) => /pg_advisory_xact_lock/i.test(call.text));
    const postingReadIndex = calls.findIndex((call) => /FROM job_posting/i.test(call.text));
    const postingWriteIndex = calls.findIndex((call) => /UPDATE job_posting/i.test(call.text));
    const outboxIndex = calls.findIndex((call) => /INSERT INTO event_outbox/i.test(call.text));
    expect(lockIndex).toBe(0);
    expect(calls[postingReadIndex]?.text).toContain('FOR UPDATE');
    expect(postingWriteIndex).toBeGreaterThan(lockIndex);
    expect(outboxIndex).toBeGreaterThan(postingWriteIndex);
    expect(calls.some((call) => /pending_publish/i.test(call.text))).toBe(false);

    const outboxCall = calls[outboxIndex]!;
    expect(outboxCall.text).toContain("'JD_GENERATED'");
    expect(outboxCall.text).toContain("'raas.events'");
    expect(outboxCall.text).toContain('ON CONFLICT (idempotency_key) DO NOTHING');
    expect(outboxCall.params?.[1]).toBe('createJD');
    expect(outboxCall.params?.[2]).toBe('trace-1');
    expect(outboxCall.params?.[6]).toBe('JP-OUTBOX-1');
    expect(outboxCall.params?.[8]).toBe(
      'JD_GENERATED:createJD:JR-OUTBOX-1:source-event-1',
    );
    expect(JSON.parse(String(outboxCall.params?.[9]))).toEqual({
      job_posting_id: 'JP-OUTBOX-1',
      job_requisition_id: 'JR-OUTBOX-1',
      client_id: 'CLIENT-1',
      jd_content: '# 智能硬件项目经理\n\n负责智能硬件项目全生命周期交付。',
    });
    expect(calls[postingWriteIndex]?.text).toContain('closed_at IS NULL');
    expect(calls[postingWriteIndex]?.text).not.toContain("'approved'");
  });

  it('propagates an outbox insert failure so the outer transaction rolls back', async () => {
    const { calls } = installTransaction(
      standardQueryHandler({ outboxError: new Error('event_outbox unavailable') }),
    );

    await expect(syncJdToPartnerPg(baseInput())).rejects.toThrow(
      'event_outbox unavailable',
    );
    expect(calls.some((call) => /UPDATE job_posting/i.test(call.text))).toBe(true);
    expect(calls.some((call) => /INSERT INTO event_outbox/i.test(call.text))).toBe(true);
  });

  it('reuses the stable event id when the same source event is replayed', async () => {
    const expectedPayload = {
      job_posting_id: 'JP-OUTBOX-1',
      job_requisition_id: 'JR-OUTBOX-1',
      client_id: 'CLIENT-1',
      jd_content: '# 智能硬件项目经理\n\n负责智能硬件项目全生命周期交付。',
    };
    const { calls } = installTransaction(
      standardQueryHandler({
        insertedEventId: null,
        replayRow: {
          event_id: 'JD-EVENT-EXISTING',
          event_name: 'JD_GENERATED',
          source_action: 'createJD',
          entity_type: 'Job_Posting',
          entity_id: 'JP-OUTBOX-1',
          payload: expectedPayload,
        },
      }),
    );

    const result = await syncJdToPartnerPg(baseInput());

    expect(result).toMatchObject({
      synced: false,
      reason: 'replayed_existing_outbox',
    });
    expect(result.jd_generated_event_id).toBe('JD-EVENT-EXISTING');
    expect(result.jd_generated_idempotency_key).toBe(
      'JD_GENERATED:createJD:JR-OUTBOX-1:source-event-1',
    );
    expect(calls.some((call) => /UPDATE job_(posting|requisition)/i.test(call.text))).toBe(false);
    expect(calls.some((call) => /INSERT INTO event_outbox/i.test(call.text))).toBe(false);
  });

  it('fails closed when an idempotency key points to different event content', async () => {
    installTransaction(
      standardQueryHandler({
        insertedEventId: null,
        replayRow: {
          event_id: 'JD-EVENT-WRONG',
          event_name: 'JD_GENERATED',
          source_action: 'createJD',
          entity_type: 'Job_Posting',
          entity_id: 'JP-OUTBOX-1',
          payload: {
            job_posting_id: 'JP-OUTBOX-1',
            job_requisition_id: 'JR-OUTBOX-1',
            client_id: 'CLIENT-1',
            jd_content: '# different content',
          },
        },
      }),
    );

    await expect(syncJdToPartnerPg(baseInput())).rejects.toThrow(
      /outbox idempotency collision/,
    );
  });

  it('does not reset or re-emit an already approved JobPosting', async () => {
    const { calls } = installTransaction(
      standardQueryHandler({
        posting: existingPosting({ publish_status: 'approved' }),
      }),
    );

    const result = await syncJdToPartnerPg(baseInput());

    expect(result).toEqual({
      synced: false,
      job_posting_id: 'JP-OUTBOX-1',
      job_requisition_id: 'JR-OUTBOX-1',
      reason: 'skipped_protected_existing_posting',
    });
    expect(calls).toHaveLength(2);
    expect(calls.some((call) => /UPDATE job_posting/i.test(call.text))).toBe(false);
    expect(calls.some((call) => /event_outbox/i.test(call.text))).toBe(false);
  });

  it('does not reopen a recruiting posting even if its fine-grained status is stale', async () => {
    const { calls } = installTransaction(
      standardQueryHandler({
        posting: existingPosting({ status: 'recruiting', publish_status: 'rejected' }),
      }),
    );

    const result = await syncJdToPartnerPg(baseInput());

    expect(result.reason).toBe('skipped_protected_existing_posting');
    expect(calls.some((call) => /UPDATE job_posting/i.test(call.text))).toBe(false);
    expect(calls.some((call) => /event_outbox/i.test(call.text))).toBe(false);
  });

  it('fails closed if the guarded posting update unexpectedly loses its state predicate', async () => {
    let postingReads = 0;
    const { calls } = installTransaction(async ({ text }) => {
      if (/pg_advisory_xact_lock/i.test(text)) return { rows: [], rowCount: 1 };
      if (/FROM job_posting/i.test(text)) {
        postingReads += 1;
        return postingReads === 1
          ? { rows: [existingPosting()], rowCount: 1 }
          : {
              rows: [existingPosting({ publish_status: 'approved' })],
              rowCount: 1,
            };
      }
      if (/FROM event_outbox/i.test(text)) return { rows: [], rowCount: 0 };
      if (/UPDATE job_posting/i.test(text)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });

    const result = await syncJdToPartnerPg(baseInput());

    expect(result.reason).toBe('skipped_protected_existing_posting');
    expect(calls.some((call) => /UPDATE job_requisition/i.test(call.text))).toBe(false);
    expect(calls.some((call) => /INSERT INTO event_outbox/i.test(call.text))).toBe(false);
  });
});
