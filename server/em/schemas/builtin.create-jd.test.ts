import { describe, expect, it } from 'vitest';
import { BUILTIN_SCHEMAS_BY_NAME } from './builtin';

function registration(name: string) {
  const value = BUILTIN_SCHEMAS_BY_NAME.get(name);
  if (!value) throw new Error(`missing builtin event schema: ${name}`);
  return value;
}

describe('builtin createJD event contracts', () => {
  it('routes REQUIREMENT_LOGGED through clarification instead of createJD', () => {
    const value = registration('REQUIREMENT_LOGGED');
    const parsed = value.versions[0]!.schema.safeParse({
      entity_type: 'Job_Requisition',
      entity_id: 'JR-LOGGED-1',
      event_id: 'LOGGED-1',
      payload: {
        job_requisition_id: 'JR-LOGGED-1',
        job_requisition_specification_id: 'JRS-1',
        client_id: 'CLIENT-1',
        hro_service_contract_id: 'CONTRACT-1',
        source_channel: 'dashboard_manual',
        raw_input_data: {},
        is_urgent: false,
      },
    });

    expect(parsed.success).toBe(true);
    expect(value.subscribers).toEqual([
      'raas-backend.requirement-clarification-gate',
    ]);
    expect(value.subscribers).not.toContain('createJdAgent');
  });

  it('accepts the current CLARIFICATION_READY payload and routes it to createJD', () => {
    const value = registration('CLARIFICATION_READY');
    const parsed = value.versions[0]!.schema.safeParse({
      entity_type: 'Job_Requisition',
      entity_id: 'JR-1',
      event_id: 'READY-1',
      payload: {
        job_requisition_id: 'JR-1',
        client_id: 'CLIENT-1',
        clarification_status: 'Ready',
        clarify_questions: [],
      },
    });

    expect(parsed.success).toBe(true);
    expect(value.subscribers).toEqual(['ao.createJdAgent']);
  });

  it('accepts manual force_ready with the JR id only in the envelope', () => {
    const value = registration('CLARIFICATION_READY');
    const parsed = value.versions[0]!.schema.safeParse({
      entity_type: 'Job_Requisition',
      entity_id: 'JR-MANUAL-1',
      event_id: 'READY-MANUAL-1',
      payload: {
        clarification_status: 'Ready',
        must_have_skills: [],
        nice_to_have_skills: [],
        clarify_questions: [],
        work_years: null,
        city: null,
        headcount: null,
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('validates the durable JD_GENERATED handoff and current RAAS consumer', () => {
    const value = registration('JD_GENERATED');
    const parsed = value.versions[0]!.schema.safeParse({
      entity_type: 'Job_Posting',
      entity_id: 'JP-1',
      event_id: 'GENERATED-1',
      payload: {
        job_posting_id: 'JP-1',
        job_requisition_id: 'JR-1',
        client_id: 'CLIENT-1',
        jd_content: '# 智能硬件项目经理',
      },
    });

    expect(parsed.success).toBe(true);
    expect(value.publishers).toEqual(['createJdAgent']);
    expect(value.subscribers).toEqual(['raas-backend.hitl-event-fanout']);
  });

  it('accepts JD_REJECTED for audit without routing it back to createJD', () => {
    const value = registration('JD_REJECTED');
    const parsed = value.versions[0]!.schema.safeParse({
      event_id: 'REJECTED-1',
      payload: {
        jd_id: 'JP-1',
        job_requisition_id: 'JR-1',
        rejector_id: 'EMP-1',
        rejection_reason_code: 'MANUAL_REJECTED',
        feedback_details: '补充量产交付经验',
        revision_number: 2,
      },
    });

    expect(parsed.success).toBe(true);
    expect(value.publishers).toEqual(['raas-backend.jd-review']);
    expect(value.subscribers).toEqual([]);
  });
});
