// Manual trigger for REQUIREMENT_LOGGED — emits the REAL RAAS payload shape.
//
// Mirrors what RAAS Web Console sends after a recruiter saves the
// 岗位信息 form. Drops a REQUIREMENT_LOGGED event onto Inngest, which
// fans out to createJD (workflow node 4).
//
// Body (all optional — sane defaults match a 谌治中-style game-tester role):
//   {
//     "client_job_title": "采购文员岗-萨罗斯",
//     "client_job_type":  "文员",
//     "recruitment_type": "社会全职",
//     "expected_level":   "中3-高1",
//     "city":             "深圳",
//     "headcount":        3,
//     "salary_range":     "15k-16k",
//     "priority":         "高",
//     "is_urgent":        false,
//     "is_exclusive":     false,
//     "deadline":         "2026-05-29",
//     "start_date":       "2026-04-10",
//     "first_interview_format": "现场面试",
//     "first_interviewer_name": "张三",
//     "final_interview_format": "现场面试",
//     "final_interviewer_name": "李四",
//     "job_responsibility":  "...岗位职责文本...",
//     "job_requirement":     "...任职要求文本...",
//     "sd_org_name":      "腾讯综合事业部",
//     "client_id":        "uuid",
//     "client_job_id":    "999"
//   }

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { blockUnsafeDevRouteInProduction } from "@/lib/unsafe-route-guard";

type ReqBody = Partial<{
  client_job_title: string;
  client_job_type: string;
  recruitment_type: string;
  expected_level: string;
  city: string;
  headcount: number;
  salary_range: string;
  priority: string;
  is_urgent: boolean;
  is_exclusive: boolean;
  deadline: string;
  start_date: string;
  first_interview_format: string;
  first_interviewer_name: string;
  final_interview_format: string;
  final_interviewer_name: string;
  job_responsibility: string;
  job_requirement: string;
  sd_org_name: string;
  client_id: string;
  client_job_id: string;
  source_channel: string;
}>;

export async function POST(req: Request): Promise<Response> {
  const blocked = blockUnsafeDevRouteInProduction("/api/test/trigger-requirement");
  if (blocked) return blocked;

  let body: ReqBody = {};
  try {
    body = await req.json();
  } catch {
    /* empty body OK */
  }

  const clientId = body.client_id ?? randomUUID();
  const clientJobId = body.client_job_id ?? "999";
  const requirementId = `JRQ-${clientId}-${clientJobId}`;
  const eventId = randomUUID();
  const traceId = randomUUID();

  const rawInputData = {
    city: body.city ?? "深圳",
    city_id: randomUUID(),
    client_department_id: randomUUID(),
    client_id: clientId,
    client_job_id: clientJobId,
    client_job_title: body.client_job_title ?? "游戏测试工程师",
    client_job_type: body.client_job_type ?? "游戏测试",
    client_published_at: new Date().toISOString(),
    create_by: "0000199059",
    csi_department_id: randomUUID(),
    deadline: body.deadline ?? "2026-05-29",
    expected_level: body.expected_level ?? "初2-中2",
    final_interview_format: body.final_interview_format ?? "现场面试",
    final_interviewer_name: body.final_interviewer_name ?? "李四",
    first_interview_format: body.first_interview_format ?? "现场面试",
    first_interviewer_name: body.first_interviewer_name ?? "张三",
    headcount: body.headcount ?? 1,
    hro_service_contract_id: randomUUID(),
    hsm_employee_id: null as string | null,
    is_exclusive: Boolean(body.is_exclusive),
    job_requirement:
      body.job_requirement ??
      "1.计算机相关专业本科及以上学历；2.1-3 年游戏测试经验；3.熟练使用主流缺陷管理工具（Jira / TAPD）；4.熟悉性能测试工具（PerfDog 等）；5.良好的沟通能力和问题分析能力。",
    job_requisition_id: requirementId,
    job_responsibility:
      body.job_responsibility ??
      "1.负责游戏功能测试、性能测试和回归测试；2.编写测试用例和测试报告；3.跟踪缺陷生命周期，与开发协作定位修复；4.参与版本验收和上线评估；5.持续优化测试方法和流程。",
    number_of_competitors: null as number | null,
    priority: body.priority ?? "高",
    recruitment_type: body.recruitment_type ?? "社会全职",
    require_foreigner: false,
    salary_range: body.salary_range ?? "7k-11k",
    sd_org_name: body.sd_org_name ?? "雷霆互动游戏事业部",
    sd_owner_id: "0000199059",
    standard_job_role_id: `std-${randomUUID().slice(0, 16)}`,
    start_date: body.start_date ?? "2026-04-10",
  };

  const envelope = {
    entity_id: requirementId,
    entity_type: "Job_Requisition",
    event_id: eventId,
    payload: {
      client_id: clientId,
      is_urgent: Boolean(body.is_urgent),
      raw_input_data: rawInputData,
      requirement_id: requirementId,
      source_channel: body.source_channel ?? "dashboard_manual",
    },
    source_action: null as string | null,
    trace: {
      agent_name: null as string | null,
      city: rawInputData.city,
      client_job_title: rawInputData.client_job_title,
      event_id: eventId,
      headcount: rawInputData.headcount,
      operator_name: null as string | null,
      operator_role: null as string | null,
      parent_trace_id: null as string | null,
      prompt_text: null as string | null,
      raw_response: null as string | null,
      request_id: null as string | null,
      scope_type: "user_action",
      status: "success",
      system_prompt: null as string | null,
      trace_id: traceId,
      workflow_id: null as string | null,
    },
  };

  try {
    const { em } = await import("@/server/em");
    const result = await em.publish("REQUIREMENT_LOGGED", envelope, {
      source: "manual.test-trigger",
      externalEventId: eventId,
      traceId,
    });
    if (result.accepted) {
      return NextResponse.json({
        ok: true,
        requisition_id: requirementId,
        sent: { name: "REQUIREMENT_LOGGED", data: envelope },
        em_event_id: result.eventId,
        schema_version: result.schemaVersionUsed,
      });
    } else {
      return NextResponse.json(
        {
          ok: false,
          error: "EM_REJECTED",
          reason: result.reason,
          details: result.details,
          sent: { name: "REQUIREMENT_LOGGED", data: envelope },
        },
        { status: 422 },
      );
    }
  } catch (e) {
    return NextResponse.json(
      {
        error: "INTERNAL",
        message: (e as Error).message,
        hint: "Make sure Inngest dev is reachable on INNGEST_BASE_URL",
      },
      { status: 500 },
    );
  }
}
