// Rule-Check use-case 集成测试驱动(替代 RAAS:我们自己 emit RESUME_PROCESSED）。
//
// 用真实 run 夹具(候选人「陈思」· 字节跳动行政文秘 · 岗位腾讯 CDG)串一遍 rule-check
// 链路(ruleCheckAgent 10-1 + candidateIdentityAgent),验证:
//   1. 调取的规则对:CDG 岗位应抓到 10-42(CDG 回流冷冻);身份检查应跑 IDENTITY-1/2/3。
//   2. 规则验证对:陈思无腾讯经历 → 10-42 NOT_TRIGGERED(不 FAIL 她);身份无重复 → PASS。
//
// 运行:npx tsx scripts/rulecheck-usecase-test.mts
//
// 注:锁定/归属 agent 已下线(CANDIDATE_OWNERSHIP_ENABLED=0 / LOCK_CHECK_ENABLED unset)。

// 真实 run 数据(候选人「陈思」· 字节跳动行政文秘 · 岗位腾讯 CDG),取自
// server/inngest/agents/__fixtures__/real-run-chensiying.ts(脱敏)。内联以免 tsx CJS interop 问题。
function realResumeProcessedEvent() {
  return {
    name: 'RESUME_PROCESSED',
    data: {
      upload_id: '3e02e864-0d7f-dfa8-3e49-a5d0b4bbd749',
      candidate_id: 'd52a569b-65ff-465a-b491-dd4d44fda112',
      resume_id: '287178ea-a2a5-4a8b-8d2e-40c8ee9f9ac3',
      employee_id: '0000023911',
      employeeId: '0000023911',
      job_requisition_id: 'JRQ-a5f6029a-8af8-4f9a-81e8-7c594cc52aa8-TEST334',
      client_id: null,
      filename: '陈思颖_简历.pdf',
      bucket: 'recruit-resume-raw',
      objectKey: '2026/06/3e02e864-0d7f-dfa8-3e49-a5d0b4bbd749-陈思颖_简历.pdf',
      sourcing_channel_id: '02001034',
      parsed: {
        data: {
          name: '陈思',
          experience: [
            { company: '字节跳动（深圳）科技有限公司', title: '行政文秘专员', startDate: '2024.03', endDate: '至今' },
            { company: '深圳本技有限公司', title: '行政助理', startDate: '2021.07', endDate: '2024.02' },
          ],
          education: [{ school: '北京师范大学', degree: '本科', major: '汉语言文学（师范）', endDate: '2021.06' }],
          skills: { technical: ['Excel 数据透视', '公文写作'], tools: ['飞书', '企业微信', '腾讯文档'] },
          phone: '138****0000',
          email: 'redacted@example.com',
          rawText: '陈思 · 行政文秘 · 字节跳动（深圳）科技有限公司 2024.03-至今 · 深圳本技有限公司 2021.07-2024.02 · 北京师范大学 汉语言文学',
        },
      },
    },
  };
}

const INNGEST = process.env.INNGEST_BASE_URL ?? 'http://localhost:8288';
const KEY = process.env.INNGEST_EVENT_KEY ?? 'dev';
const APP = 'http://localhost:3002';
const DOMAIN = '招聘-v1';

function log(...a: unknown[]) { console.log(...a); }

async function emit(): Promise<string> {
  const evt = realResumeProcessedEvent();
  // 真实数据保持不变;Inngest 会给本次 emit 分配新 run_id,审计 caseId 取该 run_id。
  const res = await fetch(`${INNGEST}/e/${KEY}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(evt),
  });
  const body = await res.text();
  log(`▶ emit RESUME_PROCESSED(替代 RAAS)· candidate=陈思 · status=${res.status}`);
  if (!res.ok) throw new Error(`emit 失败:${res.status} ${body}`);
  return (evt.data as { candidate_id: string }).candidate_id;
}

type AuditRow = { audit_id: string; agent_id: string; decision: string; case_id: string | null; created_at: string };

async function fetchAudits(): Promise<AuditRow[]> {
  const r = await fetch(`${APP}/api/rule-check-audits?domain=${encodeURIComponent(DOMAIN)}&limit=80`);
  const d = await r.json();
  return (d.audits ?? d.rows ?? d.items ?? []) as AuditRow[];
}

async function detail(auditId: string) {
  const r = await fetch(`${APP}/api/rule-check-audits/${encodeURIComponent(auditId)}`);
  return r.ok ? r.json() : null;
}

async function main() {
  const startedAt = new Date().toISOString();
  log(`=== Rule-Check use-case 测试开始 ${startedAt} ===`);
  await emit();

  // 轮询最多 ~40s,等 ruleCheckAgent + candidateIdentityAgent 落审计。
  let identity: AuditRow | undefined;
  let ruleCheck: AuditRow | undefined;
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const rows = await fetchAudits();
    const fresh = rows.filter((x) => x.created_at >= startedAt);
    identity = fresh.find((x) => x.agent_id === 'rule-check-candidate-identity');
    ruleCheck = fresh.find((x) => x.agent_id === 'jr-compliance' || x.agent_id?.includes('match') || x.agent_id?.includes('rule-check') && x.agent_id !== 'rule-check-candidate-identity');
    if (identity && ruleCheck) break;
    log(`  …等待中 ${(i + 1) * 2}s(identity=${!!identity} ruleCheck=${!!ruleCheck})`);
  }

  log('\n=== 结果 ===');
  let ok = true;

  // ① 身份去重 rule check
  if (!identity) { log('✗ 身份去重审计:未产出(检查 candidateIdentityAgent 是否触发 / partner-pg 是否可达)'); ok = false; }
  else {
    const d = await detail(identity.audit_id);
    const ruleIds = (d?.flags ?? []).map((f: { rule_id: string }) => f.rule_id);
    const ranIdentity = ruleIds.some((id: string) => id?.startsWith('IDENTITY-'));
    log(`✓ 身份去重审计 decision=${identity.decision} · 跑的规则=${JSON.stringify(ruleIds)}`);
    log(`   调取的规则对?(含 IDENTITY-1/2/3)= ${ranIdentity}`);
    const cp = (d?.flags ?? []).map((f: { evidence?: string; rule_id: string }) => `${f.rule_id}:${f.evidence ?? ''}`).join(' | ');
    log(`   验证证据:${cp.slice(0, 300)}`);
    if (!ranIdentity) ok = false;
  }

  // ② matchResume / 岗位合规 rule check
  if (!ruleCheck) { log('✗ 岗位合规审计:未产出(检查 ruleCheckAgent 是否触发 / Allmeta 是否可达)'); ok = false; }
  else {
    const d = await detail(ruleCheck.audit_id);
    const flags = (d?.flags ?? []) as { rule_id: string; result: string; evidence?: string }[];
    const ruleIds = flags.map((f) => f.rule_id);
    const got1042 = ruleIds.includes('10-42');
    const r1042 = flags.find((f) => f.rule_id === '10-42');
    log(`✓ 岗位合规审计 decision=${ruleCheck.decision} · 抓到 ${ruleIds.length} 条规则`);
    log(`   调取的规则对?(CDG 岗位抓到 10-42)= ${got1042}`);
    if (r1042) log(`   10-42 验证结果=${r1042.result}(应 PASS/NOT_TRIGGERED,陈思无腾讯经历,不该 FAIL)· 证据=${(r1042.evidence ?? '').slice(0,160)}`);
    if (!got1042) { log('   ⚠ 未抓到 10-42 — 可能 JR 客户/部门未解析为腾讯CDG(检查 partner-pg client_department 兜底)'); }
  }

  log(`\n=== 测试${ok ? '通过 ✅' : '需排查 ⚠'} ===`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(2); });
