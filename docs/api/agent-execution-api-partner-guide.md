# AO「Agent 执行 API」对接文档

> **对接双方**:eval-test-builder(测试与评估,简称「测试侧」) ↔ Agentic Operator(招聘 Agent 生产运行时,简称「AO」)
> **响应文档**:《测试执行接入生产态 Agent —— 接口需求说明》(07_AGENT_EXECUTION_API_REQUIREMENTS.md,需求冻结稿 v1,2026-06-11)
> **本文状态**:契约提案稿 v1 —— 执行 API 字段语义按需求文档全量承接;待 §10 对齐项确认后冻结
> **日期**:2026-06-11 · 维护:AO 团队
>
> **图例**:✅ = 已上线、今天即可调用 · 🚧 = 本期交付(MVP,契约在本文冻结) · 🔭 = 二期/三期

---

## 0. 太长不看版

1. 你们要的 **A1/A2 执行 API 是 🚧 新建**,完整契约见 §4。AO 的生产规则评估引擎(`runRuleCheck`)今天就已经逐规则产出 `rule_id`(本体原始 id,如 `10-5`)、status、判定理由、LLM 全量 prompt/响应、token 用量——MVP 的工作是给它包一层 API、加本体版本固定、把「解读/证据」拆成两个字段、做 5 态 status 映射。
2. **今天就能开始联调的现成接口**:规则目录(§6)、Agent 名册(§7)、事件契约目录(§7.2)、生产审计追溯(§8)。你们可以先用这些把覆盖率分母、规则文本指纹、字段映射代码写起来。
3. **本体权威来源 = Neo4j(经 Allmeta Ontology API)**。AO 执行时实时从 Neo4j 取规则,**没有 JSON 文件回退**——取不到就报错,不会拿旧数据静默执行(§2)。
4. 一个对你们很重要的实证:同一条规则 **`10-5` 在 v0_1_002(2026-05-15,248 条)和 v0_1_003(2026-06-08,261 条)之间语义已经变了**——「简历匹配硬性要求**一票否决**」→「简历匹配硬性要求**符合度评分**」。你们坚持的版本固定是对的,AO 按 §4.3 的机制交付。
5. **11 个需要线下对齐/签字确认的口径**(5 态映射缺口、`retrieved_not_evaluated` 语义差异、needs_review 真值口径、覆盖率分母、interpretation/evidence prompt 规范、版本登记流程、鉴权边界等),全表见 §10——请逐条过,其中 ⑨ 直接影响你们归因决策树第 2 步。

---

## 1. 系统全景与环境约定

### 1.1 架构与调用拓扑

```
 测试侧 eval-test-builder
      │  HTTPS(API Key)
      ▼
 ┌──────────────────────────── AO(Next.js,端口 3002)────────────────────────────┐
 │  🚧 /api/agent-execution/executions   ← 你们调用的执行 API(本文 §4)            │
 │  ✅ /api/ontology/rules, /api/agents, /api/events, /api/rule-check-audits …    │
 │                                                                                │
 │  执行核:runRuleCheck()(生产同款引擎,纯计算、无副作用)                          │
 │     ├─ 规则获取 ──► Allmeta Ontology API(ALLMETA_BASE_URL,dev 约定 :3500)──► Neo4j │
 │     ├─ 实体取数 ──► 同上(Candidate / Resume / Job_Requisition / …)             │
 │     │                └─ 仅 Job_Requisition 有 partner Postgres 只读兜底,其余实体 Neo4j-only(§9.4) │
 │     └─ 规则评估 ──► LLM 网关(AI_BASE_URL,OpenAI 协议;附 3 个图谱查询工具)       │
 └────────────────────────────────────────────────────────────────────────────────┘

 生产事件链(Inngest,§3)与执行 API 互不干扰:执行 API 不发任何事件、不写任何外部系统。
```

### 1.2 服务与端口

| 服务 | 地址(dev 默认) | 说明 |
|---|---|---|
| AO API | `http://<ao-host>:3002` | Next.js App Router Route Handlers。dev 与 prod 均固定 3002 |
| Allmeta Ontology API | `ALLMETA_BASE_URL`(dev 约定 `http://localhost:3500`;该变量无默认值,未配置时 AO 执行直接报错) | Neo4j 之上的本体读写 API。你们若需直接查本体(规则全集/schema 内省),走它(§6.2) |
| Inngest(事件引擎) | `:8288`(与 RAAS 共享) | 生产事件链运行处;测试侧**不需要**对接它 |

### 1.3 鉴权

| 面 | 现状 | 对你们的口径 |
|---|---|---|
| AO `:3002` 现有路由 | 当前**无鉴权**(内网部署假设) | 仅限内网联调使用 |
| 🚧 执行 API(§4) | 新建时引入共享密钥 | 每次请求带 `Authorization: Bearer <key>` 或 `x-api-key: <key>`(两种任选);密钥线下交换。401 同样返回 §1.4 错误信封(`code:"UNAUTHORIZED"`, `retryable:false`) |
| Allmeta Ontology API | `Authorization: Bearer <token>`(AO 侧对应配置名 `ALLMETA_API_KEY`;**仅确认 Bearer 头可用**) | 若你们直查本体,token 线下提供 |

### 1.4 通用约定

- **Content-Type**:请求/响应均 `application/json; charset=utf-8`(SSE 端点除外)。
- **时间格式**:统一 ISO-8601 UTC 字符串(`2026-06-11T03:15:15.103Z`)。无 epoch、无本地时区。
- **错误形状**(🚧 执行 API 统一采用):`{ "error": { "code": "<MACHINE_CODE>", "message": "<人读详情>", "retryable": <bool> } }`(对齐你们 §6)。✅ 现有接口的错误形状各异,逐接口在 §6-§8 标注。
- **分页**:现有接口普遍 `limit` 钳制 + 时间窗参数(`?days=N` / `?window=7d`),**无 cursor/offset**;执行 API 是单资源轮询,不涉及。

---

## 2. 本体与规则的权威来源(先讲清,再谈接口)

这一节回答你们归因决策树第 3/4 步的前提问题:「Agent 看到的规则到底从哪来、是哪个版本」。

### 2.1 运行时取规则:Neo4j 直读,无静默回退

AO 的规则评估引擎在**每次执行时**实时调用:

```
GET {ALLMETA_BASE_URL}/api/v1/ontology/actions/ruleCheckForMatchResume/rules?domain=招聘-v1
Authorization: Bearer <token>
```

该接口遍历 Neo4j 图 `(:Action)-[:HAS_STEP]->(:ActionStep)` 与 `(:Rule)-[:GOVERNS]->(:ActionStep)`,返回 Action + 步骤(Set)分组 + 各步骤挂载的规则全集。要点:

- **权威来源就是 Neo4j**。仓库里的 `rules_v0_1_002.json` 等文件只是发布快照的镜像,执行路径**不读它们**。
- **没有静默回退**:`ALLMETA_BASE_URL`/`ALLMETA_API_KEY` 缺失、API 超时(8s)、HTTP 非 200 —— 一律抛错,该次执行以基础设施失败终止,**绝不会**拿旧 JSON 凑合跑(这正是你们「不得静默 fallback」要求在现状中已成立的部分;不成立的部分是版本固定,见 §2.3)。
- JSON 兜底只存在于**展示与审计元数据补全层**(UI 上的规则名/severity 徽标、审计行的规则名快照)——**决策路径(规则集选取、prompt 拼装、结论折叠)从不读 JSON**。

### 2.2 两层过滤:哪些规则会进入 Agent 上下文

这直接决定你们 `retrievedRuleIds` 的语义(§4.4.3):

1. **Server 端预过滤**(Allmeta 声明):返回前只保留 `executor='Agent'` **且** `enforcementLevel='mandatory'` 的规则。⚠️ 这是 Allmeta 侧的声明行为,AO 不依赖它——**AO 客户端对每条返回规则无条件再校验一次**(防御性);若上游漏出 `Human`/`optional` 规则,它会以 `included:false` + 理由「非 Agent+mandatory」出现在 provenance(因而也出现在 `retrievedRuleIds`)中。你们算覆盖率分母时需要按 Agent+mandatory 限定口径(对齐项 §10-③);**直查该端点时不要假设已过滤**(§6.2)。
2. **Client 端适用性过滤**(AO 在拼 prompt 前):按本次执行的 JR 解析出客户名 + 事业群,逐条判 `applicableClient ∈ {'通用', 客户名}` 且部门维度命中。**每一条 API 返回的规则**(无论纳入与否)都会产出一条 provenance 记录:

```jsonc
{ "rule_id": "10-42", "tier": "department",   // general | client | department
  "included": false,
  "reason": "排除：规则部门=CDG ≠ 岗位 bg=IEG" }
// reason 为自由文本(其它实际模板如「排除：规则客户=X ≠ 岗位客户=Y」「排除：executor=… / enforcement=…,非 Agent+mandatory」
// 「排除：岗位 bg 未解析,部门专属规则 fail-closed」)。⚠️ 仅供人读,不要做机器解析。
```

这份 provenance 全集就是你们 `retrievedRuleIds` 的直接来源(检索到 = 出现在 provenance 里;纳入评估 = `included:true`)。

### 2.3 版本现状(差距,如实陈述)

- live 取规则**无版本参数**,Neo4j 里存的是 LATEST,AO 现状永远按最新规则执行;审计行也没有版本列,只记 `rule_source`(`ontology-api` 等)。
- 磁盘留有两个发布快照:`rules_v0_1_002.json`(version 0.2,2026-05-15,**248 条**)与 `rules_v0_1_003.json`(version 0.3,2026-06-08,**261 条**),字段结构完全相同。
- **10-5 在两版之间名称与语义已变**:`简历匹配硬性要求一票否决`(v0.2)→ `简历匹配硬性要求符合度评分`(v0.3)。你们的验收用例 tc-de5ec703 以「10-5 字面比对一票否决」为前提,**必须固定在 rules_v0_1_002 语义下执行**——版本固定机制见 §4.3。

---

## 3. 业务事件流转全景

执行 API 只跑「简历规则校验」这一段,但理解整条链路对你们做归因(尤其是 emittedEvents / suppressedSideEffects 的语义)是必要的。

### 3.1 端到端链路(真实代码行为,非目录声明)

```
RAAS 上传简历(MinIO 落 PDF + 发 RESUME_DOWNLOADED)
   ▼
[真] ResumeParser ── MinIO 取 PDF → RoboHire 解析 → 落库(partner-pg + Neo4j Candidate/Resume)
   │   ├─ 锁定归属冲突(开关开启且 lock-only)→ RESUME_LOCKED_CONFLICT(终止,不发 PROCESSED)
   ▼
RESUME_PROCESSED ────────────────┬───────────────────────────────
   ▼                             ▼(并行旁路,审计-only)
[真] RuleCheck(规则校验)        [真] CandidateDedup(候选人查重)
   │  ↑↑ 执行 API 跑的就是这一段     └ 只写审计,不发事件,永不拦截主链
   │  实时取本体规则 + LLM 逐条评估
   ├─ 业务通过 ──► MATCH_RULE_CHECK_PASSED ──► [真] Matcher(RoboHire 评分)
   ├─ 业务未通过 ─► MATCH_RULE_CHECK_FAILED(终态;写 partner-pg match_status='未通过')
   └─ 基础设施故障 ► 不发事件、挂起重试(候选人不会因系统故障被拒)
                                      ├─ score < 40 ────────► MATCH_FAILED(终态)
                                      ├─ score ≥ 40 或无分 ──► MATCH_PASSED_NEED_INTERVIEW
                                      └─ RoboHire 不可恢复故障 ► MATCH_FAILED
                                               ▼
                              (出 AO)RAAS 消费 + HSM 人工审批
                                               ▼
                              RAAS 回发 INTERVIEW_INVITATION_REQUESTED
                                               ▼
                              [真] InterviewInviter ── RoboHire 发 AI 面试邀约
                                      ├─ 成功 ► INTERVIEW_INVITATION_SENT
                                      └─ 失败 ► INTERVIEW_INVITATION_FAILED(带 error_code 分类)
                                               ▼
                              (壳)AI 面试 → 评估 → 简历优化 → 推荐包 → 提交客户系统
                                  (AI_INTERVIEW_COMPLETED → EVALUATION_* → … → APPLICATION_SUBMITTED)

JD 支线(真):REQUIREMENT_LOGGED / CLARIFICATION_READY / JD_REJECTED
              ► [真] JDGenerator(RoboHire 生成 JD)► JD_GENERATED;其余 JD 环节为壳
```

「真」= 已实现的 Inngest 函数(共 6 个);「壳」= 名册占位,无真实执行体。完整名册随时可调 `GET /api/agents`(§7.1)。

### 3.2 现役真实 Agent(6 个)

| Agent | 节点 | 触发事件 | 发出事件 |
|---|---|---|---|
| ResumeParser(简历解析) | 9-1 | RESUME_DOWNLOADED | RESUME_PROCESSED;RESUME_LOCKED_CONFLICT(锁定冲突时,且抑制 PROCESSED) |
| **RuleCheck(规则校验)** ← 执行 API 对应段 | 10-5 | RESUME_PROCESSED | MATCH_RULE_CHECK_PASSED / MATCH_RULE_CHECK_FAILED |
| CandidateDedup(候选人查重;`/api/agents` 中 short 即此名,Inngest 函数 id `rule-check-candidate-identity-agent`) | 9-3 | RESUME_PROCESSED | (无 —— 审计旁路) |
| Matcher(简历匹配评分) | 10 | MATCH_RULE_CHECK_PASSED | MATCH_PASSED_NEED_INTERVIEW / MATCH_FAILED |
| InterviewInviter(面试邀约) | 11-1 | INTERVIEW_INVITATION_REQUESTED(RAAS 回发) | INTERVIEW_INVITATION_SENT / INTERVIEW_INVITATION_FAILED |
| JDGenerator(JD 生成) | 4 | REQUIREMENT_LOGGED / CLARIFICATION_READY / JD_REJECTED | JD_GENERATED |

> 备注:「候选人归属核验(RuleCheckCandidateOwnership)」已于 2026-06-11 下线,不在名册与部署集内。

### 3.3 关键事件 payload(真实 emit 形状)

事件可能带信封 `{ entity_type, entity_id, event_id, payload, trace }`(RAAS 风格),AO 消费端两种形状都兼容。以下为 payload 层字段。

**RESUME_PROCESSED**(ResumeParser 发;RAAS 侧也会双轨发一份):

```jsonc
{
  "upload_id": "…", "employee_id": "…",
  "candidate_id": "…", "resume_id": "…",
  "job_requisition_id": "…",            // 有值 → 规则校验只跑这一个 JR;无 → 按上传者名下在招岗位扇出
  "client_id": "…", "sourcing_channel_id": "…",
  "bucket": "recruit-resume-raw", "objectKey": "…", "etag": "…", "filename": "…", "size": 12345,
  "parsed": { "data": { /* RoboHire 解析的结构化简历 */ } },
  "hrFolder": "…", "sourceEventName": "…", "receivedAt": "…", "parsedAt": "…", "parserVersion": "…"
}
// 另恒带:employeeId(camelCase,与 employee_id 同值并存)以及 candidate / candidate_expectation /
// resume / runtime 四个遗留字段 —— 恒为空对象 {},不要从中取数;结构化简历只在 parsed.data。
// 做严格 schema 校验时按「允许未知字段」处理。
```

**MATCH_RULE_CHECK_PASSED**(规则校验通过):

```jsonc
{
  "candidate_id": "…", "resume_id": "…", "job_requisition_id": "…", "client_id": "…",
  "rule_check_result": "通过", "rule_check_reason": "",
  "upload_id": "…", "employee_id": "…",
  "audit": {                              // 审计摘要(全量在审计 API,§8)
    "rules_evaluated": 12, "graph_calls": 6,
    "llm_model": "…", "llm_duration_ms": 8000, "llm_round_trips": 1,
    "llm_prompt_tokens": 8211, "llm_completion_tokens": 902,
    "rule_source": "ontology-api", "client_id": "…", "business_group": "…", "studio": "…"
  },
  "job_requisition": { /* 完整 JR 对象 */ },
  "parsed_resume": { /* 结构化简历 */ }, "parsed_content": "…PDF 纯文本…",
  "runtime_context": { "upload_id": "…", "candidate_id": "…", "resume_id": "…",
                        "employee_id": "…", "filename": "…", "received_at": "…", "trace_id": "…" }
}
```

**MATCH_RULE_CHECK_FAILED**(规则校验未通过 —— 注意:这是**业务**未通过,基础设施故障不发这个事件):

```jsonc
{
  "candidate_id": "…", "resume_id": "…", "job_requisition_id": "…", "client_id": "…",
  "rule_check_result": "未通过", "rule_check_reason": "…汇总文案…",
  "failed_rules": [                      // ← rule_id 即本体原始 id,与你们 byRuleId 对位
    { "rule_id": "10-5", "rule_name": "…", "step_id": "…", "reason": "…" }
  ],
  "matching_score": null, "upload_id": "…", "success": false,
  "data": { "audit": { /* 同上 audit 摘要 */ } }
}
```

**MATCH_PASSED_NEED_INTERVIEW / MATCH_FAILED**(Matcher 发,统一契约):

```jsonc
{ "job_requisition_id": "…", "candidate_id": "…", "matching_score": 87,
  "upload_id": "…", "job_posting_id": "…", "candidate_match_result_id": "…",
  "overall_status": "匹配",              // '匹配' | '不匹配'
  "success": true, "data": { /* RoboHire 原始 match 结果 */ } }
```

**INTERVIEW_INVITATION_SENT**:`interview_record_id, communication_log_id, login_url, qrcode_url, candidate_email, interview_language, interview_duration_minutes, robohire_request_id, sent_at` 等。
**INTERVIEW_INVITATION_FAILED**:`error_code ∈ { MISSING_PAYLOAD, BACKFILL_FAILED, ROBOHIRE_4XX, ROBOHIRE_QUOTA, ROBOHIRE_5XX, GOHIRE_REJECTED, PERSISTENCE_WARNING, UNKNOWN }` + `error_message, http_status, failed_at`。

### 3.4 目录与现实的已知差异(消费事件目录时注意)

事件契约目录(`GET /api/events`,§7.2)以 Neo4j 同步为权威源,但有 3 个历史差异点:

1. `MATCH_PASSED_NO_INTERVIEW` 已于 2026-05-21 下线,Matcher 永不再发(目录里仍可能列出)。
2. `RESUME_PARSE_ERROR` 目录里有,但当前实现**不发**该事件。实际行为分两路:文档本身不可解析(扫描件/无可提取文字)→ 落库标记**终态失败,不重试**;RoboHire 欠费/故障/网络问题 → 重试/挂起(不落失败标记)。两路都没有事件发出。
3. `INTERVIEW_INVITATION_REQUESTED / _FAILED` 不在旧目录里,但真实在用(由 RAAS 回发 / InterviewInviter 发)。

### 3.5 执行 API 在链路中的位置与 shadow 边界

- 你们的 `scenario: "matchResume"`(本体 Action「10」简历匹配)对应 AO 链路中的 **RuleCheck 段**:按本体规则逐条评估并产出 匹配/不匹配 判定。RoboHire 数值评分在下游 Matcher 段,不属于规则评估,执行 API 不触达(所以响应里 `decisionDetail.score` 恒 `null`)。
- **shadow 是结构性保证,不是运行时开关**:执行 API 直接调用 `runRuleCheck()` 引擎函数——它本身是纯计算(取规则 → 取数 → LLM 评估 → 折叠决策),所有外部副作用(发事件、写 Neo4j 匹配结果、写 partner-pg 主表、通知)都在生产 Agent 包装层,执行 API **根本不挂载**那一层。`emittedEvents` 报「应发未发」的事件名,`suppressedSideEffects` 报被跳过的写动作(§4.2)。
- 决策逻辑与生产**同源同款**:同一个引擎函数、同一套 prompt 模板、同一个 LLM 网关与默认模型、同一条取数路径(Neo4j 经 Ontology API,miss 回退 partner-pg)。

---

## 4. Agent 执行 API 契约(🚧 MVP 交付)

### 4.0 端点总表

Base path:`http://<ao-host>:3002/api/agent-execution`

| # | 端点 | 期 | 说明 |
|---|---|---|---|
| A1 | `POST /executions` | 🚧 MVP | 受理一次单用例执行,异步,返回 executionId |
| A2 | `GET /executions/{executionId}` | 🚧 MVP | 轮询;完成后返回 结论 + trace + meta(轮询间隔建议 2-5s) |
| A3 | `GET /executions/{executionId}/llm-calls/{callId}` | 🚧 MVP(基础版) | 返回该次 LLM 调用完整 prompt/response(数据已在 AO 审计库,包一层带鉴权端点即可)。对象存储 promptRef(MinIO 链接)为 🔭 二期 |
| A4 | `GET /capabilities` | 🔭 三期 | scenario / 可固定版本枚举。MVP 期间线下对齐(本文即枚举) |
| A5 | `POST /executions/{executionId}/cancel` | 🔭 二期 | 取消执行 |

### 4.1 A1 `POST /executions` — 请求契约

请求体按你们需求文档 §4 全量承接,以下只标注 AO 侧的语义确认与限制:

```jsonc
{
  "clientRequestId": "tr-mq8xd0ri-0-4btyfy/tc-de5ec703",  // 幂等键,必填。重复提交返回同一 executionId(窗口 ≥ 7 天,见 §4.6)
  "correlation": { "runId": "…", "testCaseId": "…" },     // 透传回显,AO 不解释

  "ontology": {
    "domain": "RAAS-v1",                 // 接受 "RAAS-v1" / "raas" / "招聘-v1"(AO 内同义解析)
    "version": "rules_v0_1_002"          // 必填。版本解析机制见 §4.3;不可用 → ONTOLOGY_VERSION_UNAVAILABLE,绝不静默 fallback
  },

  "scenario": "matchResume",             // MVP 仅支持 matchResume(其余 → SCENARIO_UNSUPPORTED)
  "entry": {
    "actionId": "10",                    // 可选;仅接受 "10"
    "stepIds": null                      // 仅支持 null(全链)。⚠️ 这是**永久架构限制**而非分期问题:AO 引擎按规则全集
                                         //    单轮评估,不存在按步骤截断的执行形态;传非 null → SCENARIO_UNSUPPORTED。
                                         //    需要你们签字确认 → §10-⑩
  },

  "inputs": {
    "candidate": {
      "ref": { "store": "neo4j", "id": "C-20260424-001" }, // AO 用生产同款取数路径解引用(Ontology API → Neo4j)。
                                                           // ⚠️ 候选人/简历等实体 Neo4j-only,查无即 INPUT_REF_NOT_FOUND,无兜底
      "inline": null                                       // 二选一,inline 优先。inline schema = 本体对象 Candidate 字段结构(§10-④ 线下对齐一次)
    },
    "job": {
      "ref": { "store": "neo4j", "id": "R2026031629581" }, // 岗位是唯一有 partner-pg 只读兜底的实体(§9.4);实际命中哪个源回显在 meta.inputsResolved
      "inline": null
    },
    "overrides": null                    // 🔭 二期(逐步骤输入覆写;MVP 传非 null → INPUT_INVALID)
  },

  "mode": "shadow",                      // MVP 仅接受 "shadow"(也是结构上唯一可能的模式,见 §3.5)
  "config": {
    "model": null,                       // null = 生产默认模型;可显式指定做模型对比(透传 LLM 网关)
    "timeoutMs": 120000,
    "traceLevel": "full"                 // MVP 恒按 full 处理
  }
}
```

**inline 与 ref 同路径承诺**:inline 数据以「预置图谱上下文」方式注入——引擎仍走同一条 `buildGraphContext` 路径,只是对应槽位免取数,prompt 拼装、规则过滤、LLM 评估完全一致。不会出现「inline 走简化逻辑」的旁路。

**响应** `202 Accepted`:

```jsonc
{ "executionId": "exec-01HXXX…", "status": "pending",
  "correlation": { "runId": "…", "testCaseId": "…" } }
```

重复 `clientRequestId` → `200` + 同一 `executionId`(不重复执行)。

### 4.2 A2 `GET /executions/{executionId}` — 响应契约

字段名与你们需求文档 §5 完全一致;AO 扩展字段以 `ao` 前缀标注,你们可忽略。

```jsonc
{
  "executionId": "exec-01HXXX",
  "status": "succeeded",        // pending | running | succeeded | failed | timeout | cancelled
                                // ⚠️ 语义按你们文档:业务"不匹配"是 succeeded;
                                //    AO 侧保证:LLM 网关故障/图谱不可达/解析失败 → failed(绝不混入业务结论)。
                                //    这与生产行为同构:生产里基础设施故障也不会产生"未通过"结论(§3.1)。
  "correlation": { "runId": "…", "testCaseId": "tc-de5ec703" },

  // ── ① 业务结论 ─────────────────────────────────────────────
  "result": {
    "scenario": "matchResume",
    "decision": "not_matched",           // matched | not_matched | needs_review(映射规则 §4.4.1)
    "decisionDetail": {
      "hardRequirements": [              // 逐项硬性要求判定 —— pass 与 fail 都给(与你们 §5 示例一致,不只给 fail 项)
        { "requirement": "必备技能:…", "verdict": "fail", "byRuleId": "10-5", "reason": "…" },
        { "requirement": "学历:大专以上", "verdict": "pass", "byRuleId": "10-5", "reason": "大专,满足" }
      ],
      "score": null,                     // 恒 null:数值评分在下游 Matcher 段,不属规则评估(§3.5)
      "vetoedBy": ["10-5"]               // 触发否决的规则 id(decision=not_matched 时)
    },
    "summary": "…一段业务可读摘要…",
    "emittedEvents": ["MATCH_RULE_CHECK_FAILED"]   // 应发未发申报。matched → MATCH_RULE_CHECK_PASSED;
                                                   // not_matched → MATCH_RULE_CHECK_FAILED;
                                                   // needs_review → MATCH_RULE_CHECK_FAILED(生产同构:fail-closed 折叠,§4.4.1)
  },

  // ── ② 执行过程数据 ──────────────────────────────────────────
  "trace": {
    "steps": [
      {
        "seq": 1, "actionId": "10",
        "stepId": "10.1",                // 对齐本体 ActionStep id;AO 内部若无法一一对应,填最近步骤 id 或 null+note
        "title": "…", "status": "completed",
        "startedAt": "…Z", "endedAt": "…Z",
        "ruleIds": ["10-16", "10-17"],
        "llmCallIds": ["llm-001"],
        "toolCalls": [ { "tool": "neo4j.get_instance", "summary": "读取候选人 C-…", "ok": true } ],
        "suppressedSideEffects": [],
        "note": null
      }
      // ⚠️ 粒度说明:AO 引擎对全部规则做"单轮 LLM 评估 + ≤5 轮图谱工具调用",不是逐步骤串行执行。
      //    steps[] 按本体 ActionStep(Set)分组重建:取数动作落在 seq=1,各 Set 的规则评估按组列出,
      //    时间戳为该轮评估的整体起止。逐步骤独立计时在此架构下不存在,如实声明。
    ],

    // ★★ 逐规则评估 —— 字段语义映射详见 §4.4 ★★
    "ruleEvaluations": [
      {
        "ruleId": "10-5",                // = 本体规则原始 id,无改造无后缀(AO 端到端保留,join 安全)
        "subPoint": null,                // ⚠️ AO 每条规则单条记录,subPoint 恒 null;多个子判断点折叠在 evidence 文本里。
                                         //    若逐子点粒度对归因必要 → §10-⑩
        "stepId": "10.2",
        "status": "evaluated_violated",  // 5 态,映射表 §4.4.2
        "aoStatus": "fail",              // [AO 扩展] 引擎原生 6 态,供核对(pass|fail|insufficient_info|pending|not_triggered|not_executed)
        "ruleTextSnapshot": {
          "field": "standardizedLogicRule",
          "sha256": "ab12…",             // 对 Agent 实际读到的规则逻辑全文取 hash
          "version": "rules_v0_1_002"
        },
        "interpretation": "…Agent 对该规则的解读…",   // 🚧 MVP 新增字段(prompt 改造,§4.4.4)
        "evidence": "…引用的输入字段值与比对过程…",      // 🚧 同上
        "verdictReason": "…判定结论文案…"
      }
      // 被排除的规则(included=false → status=retrieved_not_evaluated)同样各有一条记录,verdictReason=排除理由
    ],
    "retrievedRuleIds": ["10-5", "10-16", "10-17", "…"],   // 定义:本次执行从本体加载到 Agent 侧的规则 id 全集(§4.4.3)

    "llmCalls": [
      { "callId": "llm-001", "stepId": null,
        "model": "…实际路由模型…", "purpose": "规则评估(全规则单轮)",
        "inputTokens": 8211, "outputTokens": 902, "latencyMs": 4210,
        "promptRef": "/api/agent-execution/executions/exec-01HXXX/llm-calls/llm-001"   // = A3(MVP 基础版,带鉴权),返回完整 prompt/response
      }
      // AO 架构为单轮评估 → 此数组通常恰好 1 条(重试时可能多条)
    ]
  },

  // ── ③ 执行元数据 ────────────────────────────────────────────
  "meta": {
    "agentVersion": "rule-check-agent@<git-sha>",      // AO 实现版本
    "promptVersion": "match-rule-check@<date>",        // 🚧 MVP 起为 prompt 模板引入版本常量
    "model": "…实际使用模型(含路由后型号)…",
    "ontologyLoaded": {
      "domain": "RAAS-v1",
      "version": "rules_v0_1_002",
      "ruleCount": 248,                  // 该版本全集条数(回显校验)。本次实际检索/纳入数见 trace
      "liveConsistency": null            // 仅当请求版本=当前 Neo4j 已发布版本时为对象:
                                         //   { "checked": true, "match": true, "drift": null }(§4.3 步骤 2)
    },
    "inputsResolved": {                  // [AO 扩展] 各输入实际命中的数据源 —— 你们归因第 5 步「对的是哪份权威数据」的依据
      "candidate": { "store": "neo4j" }, // candidate 恒 neo4j(无兜底);inline 时为 "inline"
      "job": { "store": "neo4j" }        // job 可能为 "partner-pg"(Neo4j miss 时唯一有兜底的实体,§9.4)
    },
    "aoAuditId": "rca_…",                // [AO 扩展] 本次执行在 AO 审计库的关联 id —— §8.2 审计 API 交叉核对的 join 键
    "mode": "shadow",
    "usage": { "inputTokens": 21611, "outputTokens": 3754, "usd": null },
                                         // ⚠️ usd 暂为 null:AO 网关现按 token 计量,无单价表(对齐项 §10-⑤)
    "startedAt": "…Z", "finishedAt": "…Z"
  },

  "error": null                          // status ∈ {failed, timeout} 时为 §4.5 结构
}
```

### 4.3 本体版本固定机制(🚧 新建)

现状是 live-LATEST(§2.3),为满足「可固定 + 不静默回退 + 回显实际加载」,MVP 引入**版本注册表**:

1. 每个发布版本(`rules_v0_1_002`、`rules_v0_1_003`、…)在 AO 侧登记一份带版本戳的规则集(与 Neo4j 发布同源同内容;登记流程线下对齐,§10-⑥)。
2. 执行时按请求的 `ontology.version` 解析:
   - 命中注册版本 → 按该版本规则集执行(过滤、拼 prompt、评估逻辑与 live 路径**同一套代码**);
   - 请求版本 = 当前 Neo4j 已发布版本 → 同时做一致性核验(条数 + 内容 hash),结果回显在 `meta.ontologyLoaded.liveConsistency`(§4.2);
   - 未注册 → `ONTOLOGY_VERSION_UNAVAILABLE`,message 列出当前可用版本。**无任何 fallback。**
3. `meta.ontologyLoaded` 回显实际加载的版本与全集条数;每条 `ruleEvaluations[].ruleTextSnapshot.sha256` 为 Agent 实际读到的 `standardizedLogicRule` 全文 hash,供你们核对「看到的是哪个版本的规则」。

### 4.4 字段语义与映射(归因消费前必读)

#### 4.4.1 `result.decision` 三态映射

AO 引擎的服务端折叠是 fail-closed 两态(PASS/FAIL),执行 API 按折叠**原因**展开三态:

| AO 折叠结果 | 折叠原因 | 执行 API `decision` |
|---|---|---|
| PASS | 全部规则 pass / not_triggered | `matched` |
| FAIL | 存在 `fail`(确认违反,已引用具体字段值) | `not_matched` |
| FAIL | 无 `fail`,但存在 `insufficient_info` / `pending` / `not_executed`(无法自证达标,fail-closed 拦下) | `needs_review` |

> 该映射不改生产折叠逻辑,只是把「拦下的原因」如实展开。生产里这两类 FAIL 同样走人工复核文案。是否符合你们真值口径 → 对齐项 §10-②。
> 备注:折叠逻辑里有「提示级(flag_only)规则不确定不阻断」分支,但 flag_only 规则在取规则阶段就被 Agent+mandatory 过滤出场,实际**永远不会进入评估**——所以凡进入评估的规则都是底线规则,该分支是防御性死分支,你们不会观察到「matched 但含不确定规则」的结果。

#### 4.4.2 逐规则 `status` 5 态映射

AO 原生证据为「provenance(检索/纳入)+ 引擎 6 态(评估结果)」两层,映射:

| 你们的 5 态 | AO 来源 | 说明 |
|---|---|---|
| `not_retrieved` | (你们侧推导) | = 在辖全集 − `retrievedRuleIds`。注意 Agent+mandatory 口径(§2.2、§10-③) |
| `retrieved_not_evaluated` | provenance `included=false` | ⚠️ **语义与你们的定义不同,必须对齐(§10-⑨)**。你们的定义是「进了上下文但执行路径没走到」;AO 单轮全规则评估架构下**这种情况结构上不存在**(凡进入 LLM 上下文的规则必被要求逐条输出)。AO 在此态上报的是另一类事实:「检索到、但被**确定性前置过滤**排除,未进 LLM 上下文」——含两种排除:① 客户/部门适用性不命中;② 防御性 executor/enforcement 再校验不过(§2.2)。`verdictReason` = 排除理由(确定性逻辑,非 LLM)。**直接套用你们归因树第 2 步会把适用性过滤误判为「Agent 编排问题」** |
| `evaluated_not_applicable` | 引擎 `not_triggered` | 进入了评估,LLM 判定触发前提不成立 |
| `evaluated_passed` | 引擎 `pass` | |
| `evaluated_violated` | 引擎 `fail` | |
| (映射缺口) | 引擎 `insufficient_info` / `pending` / `not_executed` | **你们的 5 态没有对应位**:这三类是「评估了,但因字段缺失/需人工主观判断/上游断链而无法定论」。MVP 暂映射到 `evaluated_not_applicable` 并以 `aoStatus` 区分;**建议你们增设第 6 态 `evaluated_inconclusive`**(它们正是 needs_review 的成因,折进任何现有态都会失真)→ 对齐项 §10-① |

#### 4.4.3 `retrievedRuleIds` 的精确定义

= 本次执行 Ontology API 返回的规则 id 全集(即 provenance 全集),**包含被前置过滤排除的**(适用性排除 + 防御性 executor/enforcement 排除——后者意味着 Human/optional 规则在上游漏出时也会出现在这个集合里)。它是「进了 Agent 检索面」的证据;「进了 LLM 上下文」的子集 = `ruleEvaluations` 中 `status ≠ retrieved_not_evaluated` 的部分。你们的两个公式在 AO 语义下分别对应:**检索缺口** = 在辖全集 − retrievedRuleIds(规则没到 Agent 手上);**评估缺口** = retrievedRuleIds 中被前置过滤排除的部分(到了 Agent 手上但没进 LLM)——注意后者的成因是确定性过滤而非「路径未触达」(§10-⑨)。

#### 4.4.4 `interpretation` / `evidence` 拆分(🚧 prompt 改造)

现状:引擎 prompt 要求 LLM 对每条规则输出单一 `reason`(内含解读+证据+结论,fail 时强制引用具体字段值)。MVP 将输出 schema 拆为三字段:

- `interpretation` —— Agent 认为该规则要求什么(对规则文本的解读);
- `evidence` —— 用到的输入字段名与值、比对过程;
- `verdictReason` —— 据此得出的判定。

⚠️ 这是对**生产 prompt 模板**的增量修改(随 `promptVersion` 升版),评测口径自此锚定新版。三字段的措辞规范(长度、必须引用字段值等)需要一次线下对齐 → §10-④。

#### 4.4.5 其余字段来源速查

| 接口字段 | AO 数据来源 |
|---|---|
| `decisionDetail.hardRequirements[]` | 硬性要求类规则的逐项判定展开,**pass 与 fail 都给**(requirement=要求描述,byRuleId=rule_id) |
| `summary` | 引擎 explanations 的业务化汇总(与生产审计 `failure_reasons` 同源) |
| `trace.steps[].toolCalls` | LLM 评估期间的图谱工具调用(get_instance / list_instances / list_links,≤5 轮) |
| `meta.usage` tokens | LLM 网关返回的 promptTokens/completionTokens(生产同口径,已有落库先例) |
| `llmCalls[].latencyMs` | 网关返回 durationMs |

### 4.5 错误码(对齐你们 §6,全部承接)

`status=failed/timeout` 时:

```jsonc
"error": { "code": "ONTOLOGY_VERSION_UNAVAILABLE",
           "message": "rules_v0_1_002 不可用,当前可加载版本: rules_v0_1_003",
           "retryable": false }
```

| code | AO 侧触发条件 | retryable |
|---|---|---|
| `ONTOLOGY_VERSION_UNAVAILABLE` | 请求版本不在注册表(§4.3) | 否 |
| `INPUT_REF_NOT_FOUND` | ref 解引用查无此 id(candidate:Neo4j 查无即触发,无兜底;job:Neo4j 与 partner-pg 兜底均查无)。受理后异步发现 → status=failed | 否 |
| `INPUT_INVALID` | inline 不符本体对象 schema;或 MVP 不支持的 overrides 非 null | 否 |
| `SCENARIO_UNSUPPORTED` | scenario ≠ matchResume;entry.stepIds ≠ null | 否 |
| `MODEL_UNAVAILABLE` | LLM 网关不可用/欠费(AO 网关错误分类透传) | 是 |
| `UPSTREAM_RATE_LIMITED` | LLM 网关限流 | 是 |
| `EXECUTION_TIMEOUT` | 超 timeoutMs(status 同时置 timeout) | 是 |
| `ONTOLOGY_GRAPH_UNAVAILABLE` | [AO 扩展] Ontology API/Neo4j 不可达(基础设施,绝不折成业务结论) | 是 |
| `INTERNAL` | 其他 | 视情况 |

同步 4xx(A1 即拒):`400 INPUT_INVALID`(body 不合法)、`401 unauthorized`、`409`(同 clientRequestId 但 body 不一致)、`429` + `Retry-After`(超并发)。

**再确认你们的红线**:业务「不匹配」是 `succeeded`;AO 生产行为本来就把基础设施故障与业务否决分离(故障时不产生否决结论而是挂起重试),执行 API 继承同一语义,不会污染一致性统计。

### 4.6 非功能承诺

| 项 | 承诺 | 备注 |
|---|---|---|
| 时延 | 单用例 ≤ 3 分钟 | 生产同款执行的实测主耗时为单轮 LLM 评估(数秒~数十秒)+ 图谱取数;120s 超时默认值合理 |
| 并发 | ≥ 4;超限 `429` + `Retry-After` | 你们 30-60 用例/基准跑,扇出由你们控制 |
| 幂等 | `clientRequestId` 去重窗口 ≥ 7 天(随结果保留) | 需求 ≥24h,AO 直接对齐保留期 |
| 结果保留 | execution(含 trace、LLM 全文)≥ 7 天可查 | LLM prompt/响应全文在 AO 审计库为长期保留 |
| 成本回报 | `meta.usage` tokens 必有;`usd` 暂 null | §10-⑤ |
| 安全 | 请求/响应全链路无真值;AO 实现**不读取**你们仓库任何 ground-truth 文件(物理上 AO 也不持有该仓库) | PII:trace 引用输入字段值属正常;LLM 全文请走 **A3(执行 API 鉴权下)**。⚠️ 现有审计 API(§8)为内网无鉴权,含同样的 PII 全文——访问控制边界见对齐项 §10-⑪ |

### 4.7 验收用例 walk-through(tc-de5ec703)

前置(§10-⑦ 数据环境对齐):`C-20260424-001` 与 `R2026031629581` 已存在于 AO 连接的 Neo4j;`rules_v0_1_002` 已登记。

| 你们的验收点 | AO 行为 |
|---|---|
| 1. A1 受理、A2 3 分钟内 succeeded | ✓(业务结论 not_matched,status 仍 succeeded) |
| 2. decision=not_matched,硬性技能项 verdict=fail,byRuleId=10-5 | ✓ v0_1_002 语义下 10-5=硬性要求一票否决,字面比对未命中 → fail → vetoedBy 含 10-5 |
| 3. ruleEvaluations 含 10-5 / evaluated_violated / interpretation 见"字面比对" / evidence 含双方技能列表 | ✓(依赖 §4.4.4 prompt 改造完成) |
| 4. retrievedRuleIds 含 10-5 与红线类(10-16/10-17/10-25/10-26/10-38…),id 与 rules_v0_1_002.json 严格一致 | ✓ AO 端到端不改写 rule id;注意 §2.2 预过滤口径(若某条红线规则在本体中 executor≠Agent,它不会出现——联调时逐条核对) |
| 5. meta.ontologyLoaded.version 回显一致;usage 有值 | ✓(usd=null,tokens 必有) |
| 6. MATCH_FAILED 出现在 emittedEvents,且无真实外部副作用 | ⚠️ 事件名口径修正:规则校验段的应发事件是 **MATCH_RULE_CHECK_FAILED**;`MATCH_FAILED` 是下游评分段事件,本场景不产生(§3.1/§3.5)→ §10-⑧。副作用申报:本用例(not_matched)的 `suppressedSideEffects` 预期为 `["neo4j.writeCandidateMatchResult", "partnerPg.saveRuleCheckFail(match_status=未通过)", "notification.recruitmentLifecycle"]`(即生产路径上会做、shadow 下被跳过的三类写动作);HSM 通知发生在更下游环节,本段不涉及 |
| 7. 同 clientRequestId 重复提交 → 同 executionId | ✓ |
| 8. 不存在的版本 → ONTOLOGY_VERSION_UNAVAILABLE | ✓ 无静默 fallback |

### 4.8 分期交付

| 阶段 | 内容 | 你们解锁 |
|---|---|---|
| MVP 🚧 | A1+A2+**A3 基础版**(LLM 全文,带鉴权);result(三态 decision/decisionDetail 含 pass 项/summary/emittedEvents)+ ruleEvaluations(5 态+aoStatus+interpretation+evidence+ruleTextSnapshot)+ retrievedRuleIds + meta(版本/用量/inputsResolved/aoAuditId);版本注册表;shadow;matchResume 单场景;API Key 鉴权 | 一致性 ✓ 覆盖率 ✓ 归因 ✓(含 LLM 全文深挖) |
| 二期 🔭 | promptRef 对象存储化(MinIO 链接)、A5 cancel、trace.steps 细化、inputs.overrides、错误码细分 | 预算闭环、全文外链 |
| 三期 🔭 | A4 capabilities、更多场景(processResume、evaluateInterview…)、SSE 进度流(AO 已有 SSE 先例) | 多场景基准、实时进度 |

---

## 5. 执行 API 之外:你们今天就能调的接口

以下三组接口(§6/§7/§8)**已上线**,联调期可直接使用——分别覆盖你们的「规则全集/分母/文本指纹」「agent 与事件拓扑」「执行结果交叉核对」三类需要。

---

## 6. Rules API ✅(规则目录,覆盖率分母与规则文本来源)

### 6.1 AO 聚合接口(`:3002`)— 展示聚合面,**范围有限,先读警示**

#### `GET /api/ontology/rules?domain=招聘-v1`

```jsonc
{ "ok": true,
  "rules": [ /* Rule[],形状见 §6.3 */ ],
  "source": "ontology-api",       // ontology-api | json-fallback | snapshot
  "fetched_at": "…Z",
  // drift / api_error 为可选键:无内容时整个键缺省(不是 null)
  "drift": { "only_in_api": ["…"], "only_in_json": ["…"] },
  "api_error": "…" }
// 异常:HTTP 500 { ok:false, error }
```

⚠️ **三个范围警示**(这是面向 AO 控制台的展示聚合面,不是你们的分母来源):

1. **不是全集**:live 模式返回的是 `matchResume` action 步骤上挂载的规则白名单子集;降级模式(`source:'json-fallback'`)只返回打包快照中 `10-*` 前缀的子集(约 51 条)。**永远拿不到 248/261 的域全集。**
2. **action 口径与执行引擎不同**:此接口读的是历史聚合 action `matchResume`;执行引擎读的是 `ruleCheckForMatchResume`(§2.1)。两者规则集**可能不一致**。要「执行引擎同款」的规则面,用 §6.2 第一行。
3. `drift` 是相对打包子集算的,不是相对你们的版本快照。

> 用途:看 AO 控制台视角的规则面、查单条规则原文(下方 `[ruleId]` 端点)。**覆盖率分母请用 §6.2 的域全集端点。**

#### `GET /api/ontology/rules/{ruleId}?domain=招聘-v1`

单条规则原始定义(支持本体 id 或业务 code):`200 { ok:true, rule, source }`;`404 { ok:false, reason:"not_found" }`;`502 { ok:false, reason:"api_error" }`。

### 6.2 Allmeta Ontology API 直查(`ALLMETA_BASE_URL`,Bearer 鉴权)

| 端点 | 用途 |
|---|---|
| `GET /api/v1/ontology/actions/ruleCheckForMatchResume/rules?domain=招聘-v1` | **执行引擎同款来源**:Action+步骤(Set)+规则。响应含 `action_steps[]`(步骤分组)、扁平 `rules[]`、`ruleCount`。⚠️ Allmeta 声明返回前预过滤 Agent+mandatory,但 AO 不依赖该声明(自带防御性再过滤,§2.2)——**你们直查时同样建议自行按 executor/enforcementLevel 过滤,不要假设已过滤** |
| `GET /api/v1/ontology/rules?domain=招聘-v1&limit=1000` | 域内**全部** Rule 节点(不预过滤,含 Human/optional)——你们「在辖全集」分母的正确来源;响应 `{ items: [...] }`,支持 `?cursor` 翻页 |
| `GET /api/v1/ontology/schema/rules?domain=招聘-v1` | Rule 节点实际字段集内省 |
| `GET /api/v1/ontology/actions/{ref}/steps?domain=` | 仅步骤结构(stepId 对齐用) |

错误形状:`{ error, message, details? }`,HTTP 400/401/404/502。注意本体节点为 property-bag 语义(嵌套对象存储时被 JSON 字符串化,读取按需 `JSON.parse`)。

### 6.3 Rule 对象 schema(运行时统一形状)

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | **本体规则原始 id**(`10-5`、`1-1-1`)。AO 全链路不改写,你们的 join 键安全 |
| `businessLogicRuleName` | string | 规则名 |
| `standardizedLogicRule` | string | 标准化规则逻辑全文 —— `ruleTextSnapshot.field` 指向的就是它 |
| `submissionCriteria` | string | 触发前提 |
| `specificScenarioStage` | string | 业务阶段 |
| `applicableClient` | `'通用'` \| string | 适用客户 |
| `applicableDepartment` | string | 适用部门(`N/A` = 客户级通用) |
| `relatedEntities` | string[] | 关联本体对象 |
| `businessBackgroundReason` | string | 业务背景 |
| `ruleSource` | string | 规则出处(内部流程/客户SOP/访谈沟通/…) |
| `executor` | `'Agent'` \| `'Human'` | **执行者 —— Agent 评估面只含 'Agent'**(§2.2) |
| `enforcementLevel` | `'mandatory'` \| `'optional'`(类型上可选) | **Agent 评估面只含 'mandatory'** |
| `failurePolicy` | `'block'` \| `'warn'`(类型上可选) | 违反时处置(block=立即终止) |
| `severity` | `'terminal'` \| `'needs_human'` \| `'flag_only'` | **已废弃但响应中恒在**(由 enforcementLevel+failurePolicy 推导:mandatory+block→terminal,optional+warn→flag_only,其余→needs_human)。做严格 schema 校验时请允许该字段,语义以前两者为准 |

版本参考:v0_1_002 = 248 条 / v0_1_003 = 261 条(全集口径,过滤前)。做 schema 校验请用「允许未知字段」模式——本体节点是 property-bag,字段可能随发布增加。

---

## 7. Agents & 事件目录 API ✅

### 7.1 `GET /api/agents` — Agent 名册(实时)

无参数。返回静态名册 × live Inngest 注册态 × 本体生成 shell 的合并视图:

```jsonc
{ "agents": [ {
    "short": "RuleCheck", "wsId": "10-5", "domain": "招聘-v1",
    "displayName": "…", "inngestName": "Rule Check Agent",
    "stage": "match", "kind": "auto", "ownerTeam": "…", "version": "…",
    "realness": "real",            // real(有真实执行体) | shell(占位) | unbuilt
    "slug": "agentic-operator-main-rule-check-agent",
    "paused": false,
    "lastActivityAt": "…Z",
    // 以下为预留指标位,当前固定值:status=null, p50Ms=null, successRate=null, runs24h=0, costYuan=0, spark=[0×16]
    "status": null, "p50Ms": null, "successRate": null, "runs24h": 0, "costYuan": 0, "spark": [0]
  } ],
  "meta": { "generatedAt": "…Z" } }
```

恒 200。数据源降级在 `meta.partial` 申报——注意该键**健康时整个缺省**(不是空数组,`meta.partial.length` 会在健康路径上抛错),且此端点只会报 `'ws'` 一种。**用 `realness:'real'` 过滤即得 §3.2 的 6 个现役 agent**(查重 agent 的 `short` 为 `CandidateDedup`)。

### 7.2 `GET /api/events` — 事件契约目录

Query:`stage` / `kind` / `q` / `domain` / `includeRetired=0`。返回:

```jsonc
{ "events": [ {
    "name": "MATCH_RULE_CHECK_FAILED",
    "stage": "system",               // ⚠️ 见下方警示
    "kind": "domain",                // ⚠️ 见下方警示
    "desc": "…", "publishers": ["…"], "subscribers": ["…"], "emits": [],
    "schema": "…", "schemaVersion": "…", "fields": [ /* 字段定义 */ ],
    "source": "neo4j",               // neo4j(本体同步,权威) | hardcoded(冷启动兜底) | manual
    "rateLastHour": 0, "errorRateLastHour": 0, "syncedAt": "…Z"
  } ],
  "meta": { "source": "neo4j", "lastNeo4jSyncAt": "…Z", "generatedAt": "…Z" } }
```

⚠️ **消费警示(重要)**:

1. **`stage`/`kind` 在权威模式下不可用**:`source:'neo4j'` 的行(正常运行时的全部行)`stage` 恒为 `'system'`、`kind` 恒为 `'domain'`——`trigger|domain|error|gate` 分类只在冷启动 hardcoded 兜底行上有值。因此 **`?stage=` / `?kind=` 过滤参数对权威数据等于空结果,不要用**;事件分类请以本文 §3 为准。
2. **`emits` 恒为 `[]`**(neo4j 行):拓扑请从 `publishers`/`subscribers` 推,不要依赖 emits。
3. 叠加 §3.4 的三个目录-现实差异(目录 ≠ 实时实现)。

---

## 8. 审计/追溯 API ✅(执行结果的同源交叉核对面)

执行 API 的逐规则数据与生产审计库同源。联调期你们可以用这组接口核对执行 API 的返回,或在执行 API 上线前先**观察生产真实执行**长什么样。

### 8.1 `GET /api/rule-check-audits` — 审计列表

Query:`decision(PASS|FAIL)` · `client` · `jrId` · `ruleId`(规则下钻) · `verdict(pass|fail|parked)` · `limit(≤200,默认50)` · `domain`。

恒 200:`{ rows: [...], total, meta:{ empty, error?, generatedAt, facets? } }`。行字段含:`audit_id, created_at, decision, fail_reason(非空=基础设施挂起,非业务否决), candidate_id, resume_id, job_requisition_id, client_name, llm_model, llm_duration_ms, llm_prompt_tokens, llm_completion_tokens, rules_evaluated, rule_source, n_flags, trace_id, failure_reasons[]`。

### 8.2 `GET /api/rule-check-audits/{auditId}` — 单次执行全量详情

恒 200,三种形状:`{ ok:true, detail }` / `{ ok:false, reason:'not_found' }` / `{ ok:false, reason:'error', error }`(内部错误也是 200,**不要**把所有 ok:false 当 not_found)。执行 API 的 `meta.aoAuditId`(§4.2)就是这里的 `{auditId}`。`detail` 与你们最相关的字段:

| 字段 | 内容 |
|---|---|
| `decision` / `llm_decision` / `fail_reason` | 折叠结论 / LLM 原始结论 / 基础设施失败原因(空=正常业务结论) |
| `flags[]` | 逐规则:`{ flag_id, rule_id, rule_name_snapshot, severity, applicable, result, evidence, next_action, from_raw_fallback? }`。`result` 常见值 `PASS\|FAIL\|INSUFFICIENT_INFO\|NOT_TRIGGERED\|REVIEW\|NOT_EXECUTED`,**按开放枚举解析**(历史行/原文回填行可能出现 `NOT_APPLICABLE` 等) |
| `rule_provenance[]` | `{ rule_id, tier, included, reason }` —— retrievedRuleIds 的底层数据 |
| `filtered_out_rules[]` | 被适用性排除的规则及理由 |
| `rules_evaluated` / `rules_total_in_ontology` / `rule_source` | 覆盖率素材 |
| `user_prompt` / `system_prompt` / `llm_raw_text` | **LLM 全文内联返回**(这就是 MVP 期 `promptRef:"inline"` 的兑现处) |
| `llm_model / llm_duration_ms / llm_prompt_tokens / llm_completion_tokens` | 用量 |
| `parsed_resume_full` / `job_requisition_full` / `candidate_snapshot` / `resume_snapshot` / `jr_snapshot` | 输入与实体读时快照(归因第 5 步「输入数据对不对」的核对材料) |
| `trace_id` / `parent_audit_id` / `child_audit_ids` | 血缘 |

### 8.3 `GET /api/rule-check-audits/stats?window=7d` · `GET /api/rule-check-audits/rule-health?window=30d`

窗口聚合(pass/fail/token 合计、按客户分布、top 失败规则)与逐规则健康度(`evaluated/passed/failed`,`health: blocking|idle|dead|unassessed`)。

### 8.4 ⚠️ 两个不要碰的端点

- `POST /api/rule-check-audits/{auditId}/replay`:**真实重发** RESUME_PROCESSED 走全链路,有真实副作用(写库、推下游)——评测场景禁用,你们的执行通道只走 §4。
- `POST /api/test/trigger-*`:同理,生产事件注入口,非评测通道。

---

## 9. 数据模型与语义附录

### 9.1 引擎逐规则 6 态(aoStatus)判定语义

引擎 prompt 内置如下判定顺序(决策树),理解它有助于读 `aoStatus`:

| aoStatus | 语义 |
|---|---|
| `not_triggered` | 规则触发前提不成立(如「仅腾讯岗位适用」而本单非腾讯) |
| `insufficient_info` | 判定所需字段为 null/缺失/空数组,无法定论 |
| `fail` | 字段存在且明确不满足 —— 必须引用具体字段值才允许给 fail |
| `pass` | 字段存在且满足 |
| `pending` | 需要 HSM 人工主观判断 |
| `not_executed` | 上游依赖断链(极少出现) |

服务端折叠(fail-closed):任一 `fail` → FAIL;`insufficient_info/pending/not_executed` 落在底线规则(非提示级)上 → FAIL(执行 API 展开为 `needs_review`,§4.4.1);其余 → PASS。**LLM 不输出最终 decision,折叠在服务端做**——所以「Agent 解读了什么」(interpretation)与「最终结论」(decision)天然分离,正合你们归因树第 3 层的需要。

### 9.2 生产审计持久化模型(供理解,非接口契约)

- `RuleCheckAudit`(主表):每次规则校验执行一行。结论(`decision`/`llm_decision`/`failure_reasons`/`fail_reason`)、用量(`llm_model/llm_duration_ms/llm_prompt_tokens/llm_completion_tokens`)、规则面(`rules_evaluated/rules_total_in_ontology/rule_source/rule_provenance/filtered_out_rules`)、全文(`user_prompt/system_prompt/llm_raw_text`)、输入快照、血缘(`parent_audit_id/trace_id`)。
- `RuleCheckFlag`(子表):逐规则一行 —— `rule_id / rule_name_snapshot / severity / applicable / result(开放枚举,§8.2)/ evidence / next_action`。注意 `rule_name_snapshot`/`severity` 是写入时从规则目录补的展示元数据(目录降级时可能来自 JSON 兜底,§2.1);判定本身(result/evidence)始终来自 live 执行。
- 🚧 执行 API 将新增 execution 记录表(executionId、clientRequestId 唯一键、状态机、请求/结果 JSON);与审计行的关联通过 `meta.aoAuditId` 显式暴露给你们(§4.2、§8.2)。

### 9.3 ID 对齐速查(对你们附录 A 的逐项回应)

| 字段 | 权威来源 | AO 侧确认 |
|---|---|---|
| `ruleId` | 本体 Rule 节点 `id` | ✓ 端到端原样保留(`10-5`/`1-1-1` 形态) |
| `actionId` / `stepId` | 本体 Action/ActionStep | ✓ stepId 即 ActionStep 的 `id` 字段(招聘域发布快照中为 `10-1`/`10-2` 这类连字符形态);联调时双方以 `GET /actions/{ref}/steps?domain=` 实查同一接口对齐,不要各自假设格式 |
| 事件 id | 本体事件目录 | ✓ `MATCH_RULE_CHECK_FAILED` 等;注意 §3.4 差异与 §4.7-6 的口径修正 |
| `scenario` | 线下冻结枚举 | MVP = `matchResume` 一项 |
| 候选人/岗位 `ref.id` | Neo4j 权威数据 | AO 对 id **不做格式校验**(透传字符串)。`C-20260424-001` / `R2026031629581` 样式以你们与 AO 共同的数据环境为准(§10-⑦ 对齐时逐条验证存在性) |
| `ontology.version` | 版本注册表(§4.3) | MVP 起可用版本:`rules_v0_1_002`、`rules_v0_1_003` |

### 9.4 ref 模式取数路径(归因第 5 步的事实依据 —— 按实体精确区分)

`ref` 解引用走生产同款路径,但**不同实体的取数方式和兜底覆盖不同**,复现取数时请严格按下表:

| 上下文槽位 | 取数方式 | partner-pg 兜底 |
|---|---|---|
| 候选人(Candidate) | `GET /api/v1/ontology/instances/Candidate/{candidate_id}?domain=…`(按主键) | **无 —— Neo4j-only,miss 即 miss** |
| 岗位(Job_Requisition) | `GET /api/v1/ontology/instances/Job_Requisition/{jr_id}?domain=…`(按主键) | **有**(当前唯一注册了兜底的实体;命中哪个源回显在 `meta.inputsResolved`) |
| 简历(Resume) | `GET /api/v1/ontology/instances/Resume?domain=…&candidate_id={id}`(**列表查询,取第一行**——不是按 resume_id 点查) | 无(列表路径 404→空数组,无兜底) |
| 历史投递(Application) | `GET /api/v1/ontology/instances/Application?domain=…&candidate_id={id}`(列表全量) | 无 |
| 黑名单(Blacklist) | `GET /api/v1/ontology/instances/Blacklist?domain=…&candidate_id={id}`(列表全量) | 无 |
| 雇佣关系 | `GET /api/v1/ontology/links?domain=…&from={candidate_id}&type=EMPLOYED_BY` | 无 |

⚠️ 归因第 5 步比对「evidence 引用的字段值 vs 权威数据」时注意:简历槽位是**候选人名下简历列表的第一行**——若该候选人有多份简历,Agent 用的不一定是你们想的那份;比对前先按同样的列表查询确认。评估期间 LLM 还可经 3 个工具(`get_instance` / `list_instances` / `list_links`)补查,全部记入 `trace.steps[].toolCalls`。

---

## 10. 线下对齐清单(冻结契约前需要你们确认的事)

| # | 事项 | AO 建议 |
|---|---|---|
| ① | 5 态 status 的映射缺口:`insufficient_info/pending/not_executed` 三类「评估了但无法定论」在你们枚举中无位置 | 增设 `evaluated_inconclusive` 第 6 态;若坚持 5 态,按 §4.4.2 折入 not_applicable + aoStatus 区分 |
| ② | `needs_review` 与你们真值口径的关系(真值是二值「应匹配/不应匹配」还是三值?) | 按 §4.4.1 映射;一致性统计中 needs_review 如何计,你们定 |
| ③ | 覆盖率分母口径:AO 检索面 = executor=Agent 且 enforcementLevel=mandatory 的子集 | 分母同口径限定;或把 Human/optional 规则的缺位单独归类,不计 Agent 检索失败 |
| ④ | `interpretation`/`evidence` 拆分的 prompt 措辞规范(长度、引用格式);inline 输入的对象 schema(以本体 Candidate / Job_Requisition_Specification 字段结构为准) | 各一次线下评审 |
| ⑤ | `meta.usage.usd`:AO 网关无单价表 | MVP 报 tokens、usd=null;预算闸建议以 token 计;或你们提供单价表由 AO 折算 |
| ⑥ | 版本注册流程:谁发布 `rules_v0_1_00X`、如何同步登记到 AO(发布物 + 内容 hash) | 建议:本体发布方每次发版把版本化规则集交付 AO 登记,AO 核验与 Neo4j 一致后生效 |
| ⑦ | 数据环境对齐:验收用例锚定 id 在 AO 所连 Neo4j 中的存在性逐条核验;**特别注意候选人等实体 Neo4j-only 无兜底**(§9.4) | 联调前半天,双方各自连同一环境互查 |
| ⑧ | 验收点 6 的事件名口径:规则校验段应发事件为 `MATCH_RULE_CHECK_FAILED`(`MATCH_FAILED` 属下游评分段,本场景不产生) | 验收文档更新为 emittedEvents=["MATCH_RULE_CHECK_FAILED"] |
| ⑨ | **`retrieved_not_evaluated` 语义差异(影响归因树第 2 步)**:你们定义为「进了上下文但路径未触达」;AO 单轮全规则评估架构下该情况结构上不存在,AO 在此态上报的是「确定性前置过滤排除(适用性/executor 不命中),未进上下文」(§4.4.2) | 归因树第 2 步改写:此态 → 查 verdictReason 的排除理由,归类为「适用范围裁定」而非「Agent 编排问题」;或 AO 新增扩展态单独承载,此态恒空 |
| ⑩ | 两项契约偏差签字确认:`entry.stepIds` 永久不支持(单轮评估架构,非分期问题,§4.1);`subPoint` 恒 null(每规则单条记录,子判断点折叠进 evidence,§4.2) | 若逐子点/逐步骤粒度对你们必要,需另行设计,不在现行引擎形态内 |
| ⑪ | 鉴权与 PII 边界:执行 API(含 A3 全文)带 API Key;但 AO 既有审计/规则接口(§6.1、§7、§8)为内网无鉴权,审计 API 含同样的 PII 全文 | 联调期接受内网边界,或由 AO 给既有只读面补同一套 Key(工作量小,按需) |

---

## 附:联调路径建议(时间顺序)

1. **现在就可以做**:拿到内网地址 + Allmeta token → 调通 §6/§7/§8 的现成接口 → 用 §6.2 的 `GET /api/v1/ontology/rules?domain=招聘-v1`(域全集)与你们的 `rules_v0_1_002.json` 核对规则 id/文本(⚠️ 不要用 §6.1 做这件事,它只返回 action 子集)→ 写好你们侧的 5 态映射与 CaseResult 落库代码(可拿 §8.2 的真实生产审计当样例数据)。
2. **MVP 交付后**:走 §4.7 验收用例 tc-de5ec703 全链路 → 核对 8 个验收点 → 冻结契约。
3. **基准跑**:你们扇出 30-60 用例(≤4 并发)→ 一致性/覆盖率/归因三件套产出。
