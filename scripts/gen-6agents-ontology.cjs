/* Generate 6-agent-anchored ontology for 招聘-v1, ALIGNED TO DEPLOYED CODE.
 *  - actions: 6 live actions; trigger/triggered_event patched to match the agents'
 *    real createFunction triggers + step.sendEvent emits (code is the truth).
 *  - events: exactly the events on the 6-agent chain (objects untouched).
 *  - rules: ALL 261 kept; only specificScenarioStage reclassified into the 4 live
 *    stages; id + 13-field schema FROZEN (no added fields).
 */
const fs = require('fs');
const path = require('path');

const DIR = 'neo4j_data/招聘- v1';
const SRC = {
  actions: path.join(DIR, 'candidate-identity/actions_v0_1_004.json'),
  events: path.join(DIR, 'candidate-identity/events_v0_1_004.json'),
  rules: path.join(DIR, 'rules_v0_1_003.json'),
};
const OUT = path.join(DIR, '6agents-latest');
fs.mkdirSync(OUT, { recursive: true });

const actions = JSON.parse(fs.readFileSync(SRC.actions, 'utf8'));
const events = JSON.parse(fs.readFileSync(SRC.events, 'utf8'));
const rulesDoc = JSON.parse(fs.readFileSync(SRC.rules, 'utf8'));
const rules = rulesDoc.rules;

// ── 6 live agents, wiring = DEPLOYED code (createFunction triggers + step.sendEvent emits) ──
const AGENTS = [
  { agent: 'JDGenerator',      inngestId: 'create-jd-agent',                     actionId: '4',    triggers: ['REQUIREMENT_LOGGED', 'CLARIFICATION_READY', 'JD_REJECTED'], emits: ['JD_GENERATED'] },
  { agent: 'ResumeParser',     inngestId: 'resume-parser-agent',                 actionId: '9-1',  triggers: ['RESUME_DOWNLOADED'],                                       emits: ['RESUME_PROCESSED', 'RESUME_LOCKED_CONFLICT'] },
  { agent: 'CandidateDedup',   inngestId: 'rule-check-candidate-identity-agent', actionId: '10-3', triggers: ['RESUME_PROCESSED'],                                        emits: ['CANDIDATE_IDENTITY_CHECKED'] }, // invoke-based; runs at RESUME_PROCESSED seam
  { agent: 'RuleCheck',        inngestId: 'rule-check-agent',                    actionId: '10-1', triggers: ['RESUME_PROCESSED'],                                        emits: ['MATCH_RULE_CHECK_PASSED', 'MATCH_RULE_CHECK_FAILED'] },
  { agent: 'Matcher',          inngestId: 'match-resume-agent',                  actionId: '10-2', triggers: ['MATCH_RULE_CHECK_PASSED'],                                 emits: ['MATCH_PASSED_NEED_INTERVIEW', 'MATCH_PASSED_NO_INTERVIEW', 'MATCH_FAILED'] },
  { agent: 'InterviewInviter', inngestId: 'interview-inviter-agent',             actionId: '11-1', triggers: ['INTERVIEW_INVITATION_REQUESTED'],                          emits: ['INTERVIEW_INVITATION_SENT', 'INTERVIEW_INVITATION_FAILED'] },
];
const ACTION_IDS = new Set(AGENTS.map((a) => a.actionId));
const WIRING_EVENTS = new Set(AGENTS.flatMap((a) => [...a.triggers, ...a.emits]));

// ── action trigger/triggered_event PATCHES — align data → deployed code ──
const ACTION_PATCHES = {
  '4':    { trigger: ['REQUIREMENT_LOGGED', 'CLARIFICATION_READY', 'JD_REJECTED'] },            // 补 REQUIREMENT_LOGGED
  '9-1':  { triggered_event: ['RESUME_PROCESSED', 'RESUME_LOCKED_CONFLICT'] },                  // 去掉代码不发的 INFO_MISSING/PARSE_ERROR
  '11-1': { trigger: ['INTERVIEW_INVITATION_REQUESTED'], triggered_event: ['INTERVIEW_INVITATION_SENT', 'INTERVIEW_INVITATION_FAILED'] },
  // 10-3 保持 RESUME_PROCESSED(invoke-based);10-1/10-2 已与代码一致 → 不 patch
};

// ── 4 live stages exposed by actions_005 ──
const STAGE_ACTIONS = { 'JD创建与更新': ['4'], '简历处理': ['9-1', '10-3'], '简历匹配': ['10-1', '10-2'], '内部面试邀约': ['11-1'] };
const STAGE_MAP = {
  'JD创建与更新': 'JD创建与更新', 'JD发布': 'JD创建与更新', 'JD审核': 'JD创建与更新',
  '需求分析': 'JD创建与更新', '需求澄清': 'JD创建与更新', '客户系统需求创建与更新': 'JD创建与更新',
  '线下需求创建与更新': 'JD创建与更新', '招聘任务分配': 'JD创建与更新',
  '简历处理': '简历处理', '候选人沟通&简历下载': '简历处理', '简历优化': '简历处理',
  '内部面试邀约': '内部面试邀约', '面试评估': '内部面试邀约', '面试辅导': '内部面试邀约',
  '客户面试协同实施': '内部面试邀约', '客户面试邀约与排期': '内部面试邀约', '面试回访与结果录入': '内部面试邀约',
  '简历匹配': '简历匹配', '推荐包生成': '简历匹配', '推荐包审核': '简历匹配', '客户推送': '简历匹配',
  '外部背调': '简历匹配', 'offer合规审批': '简历匹配', 'Offer合规审批': '简历匹配', 'offer 发送': '简历匹配',
  '材料审核': '简历匹配', '签约入职': '简历匹配', '派驻激活': '简历匹配', '薪酬谈判': '简历匹配',
  '薪酬策略建议': '简历匹配', '定级谈判': '简历匹配', '流程状态监控': '简历匹配',
};
const remapStage = (s) => STAGE_MAP[s] ?? '简历匹配';

function eventNames(v) {
  if (!v) return [];
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(eventNames);
  if (typeof v === 'object') return eventNames(v.name ?? v.event ?? v.event_name);
  return [];
}

// ── ACTIONS: select 6, apply trigger/triggered_event patches ──
const patched = [];
const actionsOut = AGENTS.map((a) => {
  const src = actions.find((x) => x.id === a.actionId);
  if (!src) return null;
  const obj = JSON.parse(JSON.stringify(src));
  const p = ACTION_PATCHES[a.actionId];
  if (p) {
    for (const k of ['trigger', 'triggered_event']) {
      if (p[k] && JSON.stringify(p[k]) !== JSON.stringify(obj[k])) {
        patched.push(`${a.actionId}.${k}: ${JSON.stringify(obj[k])} → ${JSON.stringify(p[k])}`);
        obj[k] = p[k];
      }
    }
  }
  return obj;
}).filter(Boolean);

// ── EVENTS = wiring ∪ events referenced by PATCHED actions ──
const actionEventRefs = new Set();
for (const a of actionsOut) {
  eventNames(a.trigger).forEach((e) => actionEventRefs.add(e));
  eventNames(a.triggered_event).forEach((e) => actionEventRefs.add(e));
}
const wantedEvents = new Set([...WIRING_EVENTS, ...actionEventRefs]);
const presentEventNames = new Set(events.map((e) => e.name));
const eventsOut = events.filter((e) => wantedEvents.has(e.name));
const missingEvents = [...wantedEvents].filter((n) => !presentEventNames.has(n));

// ── RULES: keep ALL 261; only remap specificScenarioStage; id + schema frozen ──
const transitions = new Map();
const rulesOut = rules.map((r) => {
  const to = remapStage(r.specificScenarioStage);
  const key = r.specificScenarioStage + ' → ' + to;
  transitions.set(key, (transitions.get(key) || 0) + 1);
  return { ...r, specificScenarioStage: to };
});

// ── write ──
const write = (f, data) => fs.writeFileSync(path.join(OUT, f), JSON.stringify(data, null, 2) + '\n');
write('actions_v0_1_005_6agents.json', actionsOut);
write('events_v0_1_005_6agents.json', eventsOut);
write('rules_v0_1_005_6agents.json', {
  metadata: {
    project_name: rulesDoc.metadata.project_name,
    document_type: rulesDoc.metadata.document_type,
    version: '0.5',
    last_updated: '2026-06-23',
    description: '人力资源外包招聘业务本体规则定义 v0.5。全部 ' + rules.length + ' 条规则保留;specificScenarioStage 归类到 6 个 live agent 的 4 个阶段。id 与 schema(13字段)未改。',
  },
  rules: rulesOut,
});

// ── MANIFEST ──
const newDist = {};
for (const r of rulesOut) newDist[r.specificScenarioStage] = (newDist[r.specificScenarioStage] || 0) + 1;
const md = [];
md.push('# 招聘-v1 · 6-agent 业务流程版(对齐 deployed 代码)\n');
md.push('triggers/emits 已对齐 6 个 agent 的真实 createFunction 触发 + step.sendEvent 产出。\n');
md.push('## 6 个 live agent → action / 事件链(已对齐)\n');
md.push('| Agent (Inngest fn) | action | 触发事件 | 产出事件 |');
md.push('|---|---|---|---|');
for (const a of AGENTS) {
  const act = actionsOut.find((x) => x.id === a.actionId);
  md.push(`| ${a.agent} (\`${a.inngestId}\`) | \`${a.actionId}\` ${act ? act.name : '?'} | ${a.triggers.join(' / ')} | ${a.emits.join(' / ')} |`);
}
md.push('\n### 对齐修正(数据 → 代码)\n');
for (const p of patched) md.push('- ' + p);
md.push('\n### 接缝说明\n');
md.push('- `10-3` 候选人查重是 **invoke-based**:Inngest 形式注册触发是 `CANDIDATE_IDENTITY_REQUESTED`(正常链路不发),实际在 `RESUME_PROCESSED` 这一步被直接 invoke,故本体 trigger 用 `RESUME_PROCESSED` 更忠实。');
md.push('- `11-1` 面试邀约前有一跳外部审批:`MATCH_PASSED_NEED_INTERVIEW`(10-2 产出)→ **RaaS 侧 HSM 审批** → 回发 `INTERVIEW_INVITATION_REQUESTED` → 触发 11-1。`INTERVIEW_INVITATION_REQUESTED` 是外部边界事件(无 AO action 产出)。');
md.push('- 6 个 agent 的部分输入由非这 6 个的步骤产出(REQUIREMENT_LOGGED/CLARIFICATION_READY/RESUME_DOWNLOADED 等),嵌在更大的 24-action 流水线 + 外部 RaaS 内,非自闭环。\n');
md.push('## 文件 & 计数\n');
md.push(`- \`actions_v0_1_005_6agents.json\` — ${actionsOut.length} 个 action`);
md.push(`- \`events_v0_1_005_6agents.json\` — ${eventsOut.length} 个事件`);
md.push(`- \`rules_v0_1_005_6agents.json\` — **${rulesOut.length} 条全保留**,schema/id 未改,仅 specificScenarioStage 归类\n`);
if (missingEvents.length) md.push(`> ⚠️ 链上但源 events 文件缺失的事件:${missingEvents.join(', ')}\n`);
md.push('## 规则按阶段分布(4 个 live stage)\n');
md.push('| 阶段 | 挂载 action | 规则数 | 运行时是否真评估 |');
md.push('|---|---|---|---|');
const evalNote = { 'JD创建与更新': '否(Feature B 才用)', '简历处理': '仅 9-15 身份规则', '简历匹配': '是(RuleCheck 10-1)', '内部面试邀约': '否' };
for (const [stage, acts] of Object.entries(STAGE_ACTIONS)) md.push(`| ${stage} | ${acts.map((a) => '`' + a + '`').join(', ')} | ${newDist[stage] || 0} | ${evalNote[stage]} |`);
md.push(`| **合计** | | **${rulesOut.length}** | |`);
md.push('\n## specificScenarioStage 归类映射\n');
md.push('| 原阶段 | → live 阶段 | 条数 |');
md.push('|---|---|---|');
for (const [k, n] of [...transitions.entries()].sort((a, b) => b[1] - a[1])) {
  const [from, to] = k.split(' → ');
  md.push(`| ${from} | ${to}${from === to ? ' (不变)' : ''} | ${n} |`);
}
fs.writeFileSync(path.join(OUT, 'MANIFEST.md'), md.join('\n') + '\n');

// ── console ──
console.log('=== 6-AGENT ONTOLOGY (code-aligned) → ' + OUT + ' ===');
console.log('actions:', actionsOut.length, '| patches applied:', patched.length);
patched.forEach((p) => console.log('   •', p));
console.log('events:', eventsOut.length, 'of', wantedEvents.size, '| missing:', missingEvents.length ? missingEvents : 'none');
console.log('rules:', rulesOut.length, '(source', rules.length + ')', rulesOut.length === rules.length ? 'ALL KEPT ✓' : '!! DROPPED');
console.log('rule schema fields:', Object.keys(rulesOut[0] || {}).length, '(应为 13)');
console.log('new stage distribution:', JSON.stringify(newDist));
