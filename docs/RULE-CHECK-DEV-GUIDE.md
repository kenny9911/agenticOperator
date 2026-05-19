# Rule Check 模块 — 开发交接文档

> 范围: `lib/rule-check/`(production / full impl)、`lib/simple-rule-check/`(MVP baseline)、`app/rule-check/*`(commercial UI)、`app/dev/rule-check/`(engineering preview)、`scripts/rule-check.ts` / `scripts/simple-rule-check.ts`(CLI)、`data/rule-check-runs/` / `data/simple-rule-check-runs/`(filesystem 审计存储)。
>
> 作用: 给接手 / 继续开发的同学一份**自包含**的指南。在本文档中能找到代码结构、运行方式、数据流、扩展点、调试技巧、已知缺陷与路线图。
>
> 上游设计依据: [docs/RUNTIME-RULE-CHECKER-SPEC.md](RUNTIME-RULE-CHECKER-SPEC.md)。本文聚焦"代码层实际实现"——历史决策与设计原则查上面那份 SPEC。
>
> 本文档日期: 2026-05-14。

---

## 0. 一句话定义

Rule Check 是 `matchResume` 业务流程在调 Robohire 深度匹配**之前**的"规则预筛 / 红线判定"模块:

```
parseResume → matchResume agent
                  ├── generatePrompt(actionRef=matchResume, client)  ── 取规则 + Schema + 执行约束
                  ├── (NEW) ★ Rule Check  ────────────────────────── 拉运行时数据 + 调 LLM 判定 + 落审计
                  │       │
                  │       ├── overall = KEEP   → 继续调 Robohire,走原工作流
                  │       ├── overall = DROP   → 不调 Robohire,写 blacklist,emit MATCH_FAILED
                  │       └── overall = PAUSE  → 不调 Robohire,创建 humanTask 等待 HSM 反馈
                  │
                  └── (现有) saveMatchResults / emit MATCH_PASSED_NEED_INTERVIEW
```

落到本仓库, Rule Check **目前只到 LLM 判定 + 落审计**这一层。下游的 blacklist 写入 / humanTask 创建是雨函在 AO 端要做的工作(见 [docs/RUNTIME-RULE-CHECKER-SPEC.md](RUNTIME-RULE-CHECKER-SPEC.md) §3、[rule-check-end-to-end-workflow.md](../rule-check-end-to-end-workflow.md))。本仓库的 commercial UI(`/rule-check/*`)与 dev preview(`/dev/rule-check`)就是这个模块的 **Prove / 审计 / 操作面板**。

---

## 1. 两套并行实现 — 必须先理解

仓库里现存**两个独立的、并行的** rule-check 实现, 路径互不依赖:

| 维度 | `lib/simple-rule-check/` (MVP, frozen) | `lib/rule-check/` (Full, active) |
|---|---|---|
| 入口 | `checkRule(input)` 单条规则; `checkRules` 抛 `NotImplementedError` | `checkRules(input)` 一次性跑完一个 action 的所有规则; `checkRule()` 是 `checkRules` 的过滤器糖 |
| Prompt 来源 | 手写 `prompt/extractor.ts`(单 rule 抽出 + 包一层执行约束) | **直接消费** `generatePrompt()` 输出 + 短 focusing system 消息(`prompt/build.ts` + `prompt/focusing-system.ts`) |
| LLM 调用拓扑 | 1 rule = 1 LLM call(单条) | **Path C**: 1 action 内每个 `actionStep` 一个 LLM call(按 `stepOrder` 串行), 整批 = N calls;触发 `blocked` 且 `canBlock !== false` 时短路后续 step |
| 输出 schema | `RuleJudgmentJsonSchema`(扁平判定) | `MatchResumeEvalEnvelopeJsonSchema` / 单 step 用 `StepResultJsonSchema`,与 `matchResume` executor agent **共享 envelope** |
| 置信度 | `LLMSelfReported` 直接透传 | `Composite`: `0.4·logprob + 0.3·evidenceCount + 0.3·consistency`;无 logprobs 时降级到 `0.5·evidenceCount + 0.5·consistency` |
| 校验失败处理 | 校验未通过强制 `pending_human`(`overrideReason = "validation_failed: ..."`) | **v3.1 起仅当 LLM 输出 Zod 解析失败(`parsed === null`)才强制 `pending_human`**;其他校验信号(`ruleIdExists` / `schemaValid` per-field / `blockSemantic warning` / `evidenceGrounded`)只记入 `validation.failures[]` 作审计观测,**不再覆盖** LLM 的 `decision` |
| 审计存储 | `data/simple-rule-check-runs/<YYYYMMDD>/<runId>.json` | `data/rule-check-runs/<YYYYMMDD>/<runId>.json` + `data/rule-check-runs/batches/<batchId>.json` + `data/rule-check-runs/index.jsonl` |
| HTTP trace | 无 | `OntologyApiTrace`: 每一个 Ontology API GET 都进 `ontologyApiTrace[]`(`store/ontology-trace-recorder.ts` 拦截层) |
| 输出类型 | `RuleCheckRun` | `RuleCheckRunAudited` + `RuleCheckBatchRunAudited`(扩展了 provenance / counterfactuals / stepCalls / ontologyApiTrace / confidenceBreakdown 等审计字段) |
| CLI | `npm run simple-rule-check` | `npm run rule-check` |
| Dev UI | (历史路径)`/dev/simple-rule-check` | `/dev/rule-check` |
| Commercial UI | 无 | `/rule-check`(aggregate)、`/rule-check/matrix`、`/rule-check/batches/[batchId]`、`/rule-check/runs/[runId]`、`/rule-check/rules`、`/rule-check/candidates/[id]`、`/rule-check/audit`、`/rule-check/settings` |

**约定**:
- MVP 模块**冻结**, 只接安全 / schema-drift 修复,不再做特性。它就是用来 A/B 对比 full impl 的简单基线。
- 二者**有意保持互不导入**(MVP 不依赖 full,full 也不从 MVP 复用代码), 只在 `lib/rule-check/types.ts` 顶部从 MVP `types.ts` re-export 一些基础类型(避免重复)。MVP 的 `rule-instance-map.ts` / `fetch-instances.ts` / `validation/*` 都被 **sibling-copy** 进 full 重新独立演进(per SPEC §15 locked decision)。
- 文档 / 代码里"the Checker"通常指 full impl,除非显式说"MVP"。

---

## 2. 仓库结构 — 一张图

```
agenticOperator/
├── lib/
│   ├── rule-check/                          ← Full / production impl (active)
│   │   ├── index.ts                         ABI: { checkRule, checkRules, 全部 audited 类型 }
│   │   ├── checker.ts                       checkRules() → allInOneOrchestrator.run(); checkRule() = 单 rule 过滤糖
│   │   ├── types.ts                         re-export MVP 基础类型 + 加 FetchedRuleClassified
│   │   ├── types-audited.ts                 RuleJudgmentAudited / RuleCheckRunAudited / RuleCheckBatchRunAudited / PromptProvenance / OntologyApiTraceEntry / StepCallRecord / BatchAggregateDecision / HumanOverride / AskWhyEntry
│   │   ├── output-schema-audited.ts         Zod + JSON Schema(re-export 自 lib/ontology-gen/v4/envelope-schema.ts)
│   │   ├── debug.ts                         rcLog/rcInfo/rcDebug/rcWarn + rcStopwatch + RULE_CHECK_DEBUG=1 解析
│   │   ├── aggregate-decision.ts            cascade 聚合: blocked > pending_human > passed > not_started
│   │   ├── llm-client.ts                    OpenAI SDK + streaming + strict json_schema + RULE_CHECK_LOGPROBS env
│   │   ├── fetch-rules.ts                   wrap fetchAction + applyClientFilter, 派生 canBlock / requiredInstances
│   │   ├── fetch-instances.ts               Ontology GET single/list, 走 tracedGetJson 把 HTTP 进审计 trace
│   │   ├── fetch-extra-instances.ts         按 rule.spec 预取 Candidate / Candidate_Expectation / Application / Blacklist(去重 + 稳定排序)
│   │   ├── rule-instance-map.ts             硬编码 ruleId → InstanceSpec(10-7 / 10-17 / 10-18 / 10-25 / 10-32 已映射)
│   │   ├── instance-overview.ts             collectCandidateFields / collectJobFields / pickCandidateInstance / pickJobInstance(UI overview 卡数据)
│   │   ├── server-actions.ts                所有 `/rule-check/*` 服务端动作的实现; routes 端 actions.ts 只是 thin re-export
│   │   ├── orchestrator/
│   │   │   ├── index.ts                     Orchestrator 接口 + re-export allInOneOrchestrator
│   │   │   └── all-in-one.ts                ★ Path C 编排核心: A-G 阶段, per-step LLM, short-circuit, 合成 not_started, 持久化
│   │   ├── prompt/
│   │   │   ├── build.ts                     buildEvalPrompt: generatePrompt → fillRuntimeInput → SHA256 provenance(stripCurrentTimeBlock)
│   │   │   ├── focusing-system.ts           FOCUSING_SYSTEM_MESSAGE (告诉 LLM "user message 才是权威规范")
│   │   │   └── runtime-input-loader.ts      loadMatchResumeRuntimeInput: 并发 fetchJob + listResumes,选最新 resume,装成 MatchResumeRuntimeInput
│   │   ├── validation/
│   │   │   ├── index.ts                     runValidationAudited: schema → ruleId → evidenceGrounded → blockSemantic
│   │   │   ├── schema.ts                    Zod safeParse,失败列 issues
│   │   │   ├── rule-id.ts                   LLM ruleId 必须在 fetchedRules 内
│   │   │   ├── evidence-grounded.ts         JSONPath-lite 路径解析 + deepEqual,失败 fail + 写 `ev.grounded` 标记
│   │   │   └── block-semantic.ts            canBlock=false ∧ decision=blocked → warning; required_instances 缺失 → warning
│   │   ├── confidence/
│   │   │   ├── index.ts                     ConfidenceCalculator 接口 + re-export composite
│   │   │   └── composite.ts                 0.4·logprob + 0.3·evidenceCount + 0.3·consistency(无 logprobs 时 50/50)
│   │   └── store/
│   │       ├── index.ts                     RunStore 接口 + RunQuery / RunIndexEntry
│   │       ├── filesystem.ts                ★ writeRun / writeBatch / listRuns / getRun / getBatch (JSONL index)
│   │       ├── external.ts                  openSearch / clickHouse stubs(都抛 NOT_IMPLEMENTED,文档形)
│   │       └── ontology-trace-recorder.ts   tracedGetJson: 包 getJson, 把每一次 HTTP 推进 traceCtx.trace[]
│   │
│   ├── simple-rule-check/                   ← MVP baseline (frozen) — 见 §1 表格,结构与 full 类似但简化
│   │   ├── index.ts / checker.ts / types.ts / output-schema.ts / llm-client.ts / debug 缺
│   │   ├── prompt/
│   │   │   ├── extractor.ts                 ★ 手写 system + user(单 rule 抽出, 含 4 段 rootCause 规范)
│   │   │   ├── full.ts                      throw "not implemented in MVP"
│   │   │   └── index.ts
│   │   ├── orchestrator/
│   │   │   ├── single-call.ts               ★ 8 阶段 pipeline,无 trace,无 stepCalls
│   │   │   └── all-in-one.ts                throw "not implemented in MVP"
│   │   ├── validation/                      四个 check 模块 + index 聚合(逻辑同 full 但不写 ev.grounded)
│   │   ├── confidence/                      self-reported.ts / composite.ts / index.ts
│   │   ├── store/                           filesystem.ts(无 index.jsonl,只按日期分目录) + neo4j.ts(写 Neo4j 是禁的,文件存在但不应使用)
│   │   ├── rule-instance-map.ts             硬编码 5 条 MVP rule;未映射的 rule 直接 throw(与 full 的"返回 null"不同)
│   │   ├── fetch-rules.ts / fetch-instances.ts
│   │
│   └── ontology-gen/                        ← upstream:rule-check 不重写 prompt, 直接用这些
│       ├── client.ts                        ★ HTTP 客户端 getJson / postJson,全部 Ontology API 流量都走这里
│       ├── fetch.ts                         fetchAction()
│       ├── compile/filter.ts                applyClientFilter() —— 按 client + department 过滤 rules
│       ├── errors.ts                        OntologyGenError / OntologyNotFoundError / OntologyRequestError
│       └── v4/
│           ├── envelope-schema.ts           ★ SSOT: MatchResumeEvalEnvelopeZod + JsonSchema + StepResultZod
│           ├── generate-prompt.ts           generatePrompt(): templated or resolved ActionObjectV4
│           ├── fill-runtime-input.ts        fillRuntimeInput(): 把 {{CLIENT}} / {{JOB}} / {{RESUME}} 替换成真值
│           ├── assemble-v4-4.ts             assembleActionObjectV4_4 / renderFinalOutputSchema / renderConstraints / renderExtraInstances
│           ├── placeholders.ts              占位符常量
│           └── runtime-adapters/
│               ├── match-resume.ts          MatchResumeRuntimeInput { job, resume }
│               └── types.ts                 RuntimeInputV4 / RuntimeScope
│
├── app/
│   ├── rule-check/                          ★ commercial UI 入口 (Next.js App Router)
│   │   ├── page.tsx                         /rule-check —— Aggregate(每行 = batch)
│   │   ├── actions.ts                       "use server" thin re-export 自 lib/rule-check/server-actions.ts,并 LOCAL 重声明所有 public 类型(见 §6.1 解释为什么必须重声明)
│   │   ├── matrix/page.tsx                  /rule-check/matrix —— rules × candidates 网格
│   │   ├── rules/page.tsx                   /rule-check/rules —— 规则字典
│   │   ├── batches/[batchId]/page.tsx       /rule-check/batches/<id> —— 单 batch 详情(verdict + stepCalls + step 分组规则卡)
│   │   ├── runs/[runId]/page.tsx            /rule-check/runs/<id> —— 单 rule 判定的 Prove 详情(8 layers,Inference Chain 等)
│   │   ├── runs/page.tsx                    308 redirect → /rule-check (legacy URL)
│   │   ├── candidates/[id]/page.tsx         候选人时间线(目前只读 MOCK_RUNS,未串实际数据)
│   │   ├── audit/page.tsx                   合规导出(stub)
│   │   └── settings/page.tsx                设置(stub,未持久化)
│   │
│   └── dev/rule-check/                      ★ engineering preview ("Run new batch" 按钮指向这里)
│       ├── page.tsx                         一个手工填 actionRef/candidateId/jobRef/client/.../rules 的小表单 + 实时显示 batch 结果
│       └── actions.ts                       "use server" 调 runCheckBatch
│
├── components/rule-check/                   ★ UI 组件层
│   ├── AggregatePageView.tsx + AggregateContent.tsx       /rule-check 主页
│   ├── MatrixPageView.tsx + MatrixContent.tsx             /rule-check/matrix
│   ├── BatchDetailPageView.tsx + BatchDetailContent.tsx   /rule-check/batches/<id>
│   ├── RunDetailPageView.tsx + RunDetailContent.tsx       /rule-check/runs/<id>(8 layers)
│   ├── RuleLibraryPageView.tsx + RuleLibraryContent.tsx   /rule-check/rules
│   ├── CandidateTimelineContent.tsx                       /rule-check/candidates/<id>
│   ├── SettingsContent.tsx / AuditContent.tsx             stubs
│   ├── mock.ts                                            MOCK_RUNS — 三条样例 RuleCheckRunAudited(passed / blocked / pending_human),dev fallback 用
│   └── atoms/                                             所有 Prove UI 原子
│       ├── DecisionBadge.tsx / StatusDot 等价
│       ├── InferenceChain.tsx                             Rule → Evidence cards → Verdict 三类节点
│       ├── FactCard.tsx                                   evidence 单卡(展开内嵌不弹抽屉, hydration 安全)
│       ├── EvidenceCard.tsx                               证据账本行
│       ├── CounterfactualsList.tsx                        反事实清单
│       ├── ConfidenceRing.tsx                             圆环置信度
│       ├── LogprobInlineChart.tsx                         有 logprobs 时显示
│       ├── ValidationLight.tsx                            4 灯 (ruleIdExists / evidenceGrounded / schemaValid / blockSemantic)
│       ├── RootCauseTimeline.tsx                          3 段(数据观察 / 对照推理 / 结论)
│       ├── PromptPanel.tsx + ResponsePanel.tsx            Prompt + LLM raw response 标签页
│       ├── AskWhyChat.tsx                                 占位
│       ├── MatrixGrid.tsx                                 candidates × rules 单元格
│       ├── RunsList.tsx / RunsPreview.tsx / RunsDashboard.tsx  历史 /rule-check 列表组件(v3 之后大量被 BatchList/BatchPreview 替代)
│       ├── BatchPreview.tsx                               /rule-check 右侧实时预览面板
│       ├── ReplayButton.tsx                               重跑按钮
│       └── formatElapsed.ts                               毫秒美化
│
├── scripts/
│   ├── rule-check.ts                        npm run rule-check —— 调 checkRules(),打印 batch 结果 / json / decision-only
│   ├── simple-rule-check.ts                 npm run simple-rule-check —— 单 rule MVP CLI
│   ├── simple-rule-check-seed.ts            npm run simple-rule-check:seed —— 种 RAAS-v1 测试数据(14 实例);也是 rule-check:seed 的同名脚本(package.json alias)
│   ├── gen-v4-snapshot.ts                   npm run gen:v4-snapshot —— 把一个 action 的 ActionObjectV4 落到 generated/v4/ 当快照
│   ├── dump-match-resume-prompt.ts          npm run dev:dump-match-resume-prompt —— 把 matchResume 的 templated prompt 落到 data/dev/
│   ├── verify-client-filter.ts              校验 applyClientFilter 与 API 期望子集匹配
│   └── fill-result-prompts.ts               把 result.md 内 case 的 prompt 字段填入(开发用)
│
├── data/                                    .gitignore'd (本机)
│   ├── rule-check-runs/                     full impl 审计存储(见 §5)
│   │   ├── 20260513/<runId>.json            每个 per-rule run
│   │   ├── batches/<batchId>.json           每次 checkRules 调用
│   │   └── index.jsonl                      ★ append-only 索引(列表 / 过滤都靠它)
│   ├── simple-rule-check-runs/<YYYYMMDD>/<runId>.json
│   └── dev/                                 dump 的 prompt 落盘位置
│
└── docs/
    ├── RUNTIME-RULE-CHECKER-SPEC.md         设计 SPEC(原始);1700+ 行,记录所有 locked decisions
    ├── GENERATE-PROMPT-USER-GUIDE.md        generatePrompt 上游文档
    └── RULE-CHECK-DEV-GUIDE.md              ★ 本文档
```

---

## 3. 快速上手 — 跑通本地

### 3.1 前置依赖

- Node ≥ 22 (`engines.node` in `package.json`)
- 一个**可访问**的 Ontology API(默认 `http://localhost:3500`, Bearer-token);仓库不自带 Neo4j。
- 一个 OpenAI-兼容的 LLM endpoint(线上常用 new-api 代理过来的 kimi-k2.6 / gpt-4o / Claude;支持 streaming + `response_format.json_schema` strict)。

### 3.2 `.env.local`

```bash
ONTOLOGY_API_BASE=http://localhost:3500
ONTOLOGY_API_TOKEN=...                  # required

OPENAI_API_KEY=...                      # required
OPENAI_BASE_URL=https://your-proxy.example/v1   # 可选,缺省走 OpenAI 官方
OPENAI_MODEL=kimi-k2.6                  # 可选,默认 gpt-4o
OPENAI_TIMEOUT_MS=600000                # 可选,默认 600s

# 调试旋钮
RULE_CHECK_DEBUG=1                      # 打开 lib/rule-check/debug.ts 的 verbose 日志
RULE_CHECK_LOGPROBS=1                   # 让 llm-client 申请 logprobs:true(部分 provider 会挂)
```

`.env.local` 由 npm scripts 通过 `node --env-file=.env.local` 注入(见 `package.json`);**手动 `npx tsx` 不会自动读它**, 需要 `dotenv-cli` 或自己 export。

### 3.3 种测试数据(只需一次)

```bash
npm run simple-rule-check:seed:check    # 仅 schema 验证: 14 个 label 是否在 RAAS-v1 内
npm run simple-rule-check:seed          # 写入 14 个 fixture(2 jobs + 10 candidates + 2 Applications + 各种 FK 目标)
```

`rule-check:seed` 是 `simple-rule-check:seed` 的 alias(`package.json`); full impl 复用同一份种子。

### 3.4 跑一次 Rule Check

**CLI (推荐 smoke test)**:
```bash
npm run rule-check -- \
  --candidate C-MVP-001 \
  --client 腾讯 \
  --job JR-MVP-TENCENT-001 \
  [--rules 10-7,10-17]           # 可选,缺省 = action 的所有 rule
  [--department WXG]
  [--domain RAAS-v1]             # 默认 RAAS-v1
  [--output pretty|json|decision-only]
```

输出: pretty 模式打印 batch 摘要(aggregate decision + per-step LLM 计费 + per-rule 校验灯), json 模式打印整个 `RuleCheckBatchRunAudited`, decision-only 只打印 4 个值之一。stderr 会带审计文件路径。

**Dev UI**:
```bash
npm run dev
open http://localhost:3002/dev/rule-check
```
按需填表单 → 点 "Run check" → 右侧实时显示 aggregate decision + per-rule 卡 + 折叠 trace JSON。

**Commercial UI**(看历史 / 审计):
```
http://localhost:3002/rule-check                    # 默认 landing: batches 聚合 + 实时预览面板
http://localhost:3002/rule-check/matrix             # rules × candidates 网格(单元格颜色 = 最新判定)
http://localhost:3002/rule-check/batches/<batchId>  # 单 batch 详情(step 分组规则卡)
http://localhost:3002/rule-check/runs/<runId>       # 单 rule 判定 Prove 详情(8 layers)
http://localhost:3002/rule-check/rules              # 规则字典(静态)
```

### 3.5 MVP CLI(单条 rule)

```bash
npm run simple-rule-check -- --rule 10-7 --candidate C-MVP-001 --client 腾讯 --job JR-MVP-TENCENT-001
```
输出与 full 完全不同:`RuleCheckRun`(没有 step / stepCalls / batchId / counterfactuals / ontologyApiTrace), 只一条 judgment。用来对比 baseline。

---

## 4. Full impl 数据流 — Stage A → G(production path)

入口 `lib/rule-check/index.ts::checkRules(input: CheckRulesInput)` 转给 `allInOneOrchestrator.run(input)`(`orchestrator/all-in-one.ts`)。这是**唯一**的生产路径。

```
┌──────────────────────────────────────────────────────────────────────┐
│  CheckRulesInput { actionRef, candidateId, jobRef, scope:{client,    │
│    department?}, domain?, ruleIds?, [env / llm overrides] }          │
└──────────────────────────────┬───────────────────────────────────────┘
                               ▼
┌─────────────── Stage A: fetchAllRules ─────────────────────────────────┐
│ lib/rule-check/fetch-rules.ts                                          │
│   fetchAction(actionRef, domain, apiBase, apiToken)                    │
│     → applyClientFilter({ client, clientDepartment })                  │
│     → 扁平化为 FetchedRuleClassified[]                                 │
│                                                                        │
│  canBlock 派生顺序:                                                    │
│    1) 字段 `rule.can_block` 或 `rule.canBlock`(v1.1 ontology schema)  │
│    2) `severity === "blocker"` → true; `severity === "advisory"` → false│
│    3) 否则 undefined(block-semantic check 返回 "skipped")             │
│                                                                        │
│  requiredInstances 派生:                                                │
│    `rule.required_instances` 或 `rule.requiredInstances`(数组)        │
│                                                                        │
│  input.ruleIds 不为空 → 仅保留这些 rule(filter)                       │
└──────────────────────────────┬─────────────────────────────────────────┘
                               ▼
┌─────────────── Stage B: loadMatchResumeRuntimeInput ───────────────────┐
│ lib/rule-check/prompt/runtime-input-loader.ts                          │
│   Promise.all([                                                        │
│     fetchJob(jobRef)         → Job_Requisition 单实例                  │
│     listResumes(candidateId) → 该候选人所有 Resume,按 update_timestamp │
│                                 选最新                                  │
│   ])                                                                   │
│   → MatchResumeRuntimeInput { job, resume }                            │
│                                                                        │
│  没有 Resume 直接抛 —— matchResume 没简历不能跑。                       │
│  ★ 所有 HTTP 都走 tracedGetJson, 进 ontologyApiTrace[]                  │
└──────────────────────────────┬─────────────────────────────────────────┘
                               ▼
┌─────────────── Stage C: fetchExtraInstancesForRules ───────────────────┐
│ lib/rule-check/fetch-extra-instances.ts (含义 A1: 静态 rule→deps 映射) │
│                                                                        │
│ for each active rule:                                                  │
│   spec = instancesNeededForRule(rule.id)                               │
│   if spec.needsCandidate            → push {kind:"candidate"}          │
│   if spec.needsCandidateExpectation → push {kind:"candidate_expectation"}│
│   if spec.needsApplications         → push {kind:"application", byJob, │
│                                              sinceDate, onlyStatuses}  │
│   if spec.needsBlacklist            → push {kind:"blacklist"}          │
│                                                                        │
│ 整合 = JSON.stringify-去重 → Promise.all 并发拉                        │
│ → 跨 fetch 用 `${objectType}/${objectId}` 去重 → 按字母排序            │
│ → 稳定 extraInstances[] (audit-reproducible)                           │
│                                                                        │
│ 任意一次 fetch 失败 → rcWarn 记录 + 跳过(不抛),不影响其他 rule       │
│                                                                        │
│ ★ Resume / Job 已在 Stage B,这里不再拉                                 │
└──────────────────────────────┬─────────────────────────────────────────┘
                               ▼
fetchedInstances 锚定顺序(贯穿所有 audit 写入):
   position 0  = Job_Requisition (from runtime input)
   position 1  = Resume          (from runtime input)
   position 2.. = extraInstances[] (排序后)
                               ▼
┌─────────────── Stage D: groupRulesByStep ──────────────────────────────┐
│   按 FetchedRuleClassified.stepOrder 分桶, rules.length===0 的 step    │
│   不进 groupedSteps —— tool-only step(如 step_4 generateMatchResult)   │
│   自然被跳过。                                                          │
└──────────────────────────────┬─────────────────────────────────────────┘
                               ▼
┌─────────────── Stage E: per-step sequential LLM loop ──────────────────┐
│   shortCircuitedAt: null                                               │
│                                                                        │
│   for each [stepOrder, stepRules] in groupedSteps:                     │
│     if shortCircuitedAt:  ── 跳过路径                                   │
│       for each rule:                                                   │
│         results.push(buildSyntheticSkippedRun(...))                    │
│             # decision = "not_started"                                 │
│             # validation.failures = ["short_circuit_by_step_N_rule_X"]│
│             # llmRaw.response = { skipped: "..." }                     │
│       stepCalls.push({ shortCircuited: true, llmRaw: null,            │
│                        promptProvenance: null })                       │
│       continue                                                         │
│                                                                        │
│     ── live 路径                                                       │
│     built = buildEvalPrompt({ actionRef, client, runtimeInput,         │
│                                extraInstances, focusStep: stepOrder })  │
│       # 1. generatePrompt(templated, focusStep)   ── 占位符未填        │
│       #    → actionObjectSha256(strip 当前时间 后 SHA)                  │
│       # 2. fillRuntimeInput(templated, runtimeInput, scope)            │
│       #    → resolved prompt                                            │
│       #    → promptSha256(同样 strip)                                  │
│       # 3. PromptProvenance { promptSha256, actionObjectSha256,         │
│       #                       generatePromptInput, resolvedAt }         │
│       # built.system = FOCUSING_SYSTEM_MESSAGE                          │
│       # built.user   = resolved.prompt (verbatim)                       │
│                                                                        │
│     llmRaw + rawContent + logprobs = evaluate({                        │
│       system: built.system,                                            │
│       user:   built.user,                                              │
│       jsonSchema: StepResultJsonSchema,    # ★ 单 step 子 shape         │
│       schemaName: "StepResult_step_<N>",                               │
│     })  ── streaming                                                   │
│                                                                        │
│     parsed = StepResultSchema.safeParse(rawContent)                    │
│        # 解析失败 → 该 step 所有 rule 走 buildFallbackRun → 继续下一 step│
│                                                                        │
│     for each rj in parsed.rule_judgments:                              │
│       valOut = runValidationAudited({ rawJudgment: rj, ruleClassified, │
│                                       fetchedInstances, fetchedRules })│
│         # 1. checkSchema   (Zod)                                       │
│         # 2. checkRuleId   (LLM ruleId ∈ fetchedRules?)                │
│         # 3. checkEvidenceGroundedAudited                              │
│         #    - 在 fetchedInstances 找到 (objectType, objectId)         │
│         #    - resolveFieldPath(JSONPath-lite, 支持 a.b[3].c)          │
│         #    - deepEqual(resolved, ev.value)                           │
│         #    - 同时写 ev.grounded = true|false (in-place)              │
│         # 4. checkBlockSemanticAudited                                 │
│         #    - canBlock=false ∧ decision=blocked → warning             │
│         #    - required_instances 缺失 → warning                       │
│         #    - 都没有则 ok / skipped                                   │
│                                                                        │
│       confidence = compositeCalculator.calculate({                     │
│         llmReportedConfidence, evidence, logprobs })                   │
│         # 有 logprobs: 0.4·exp(avgLogprob) + 0.3·count + 0.3·consistency│
│         # 无 logprobs: 0.5·count + 0.5·consistency                     │
│       parsedJudgment.confidence = confidence.value  (override LLM 自报) │
│                                                                        │
│       finalDecision = computeFinalDecision(parsedJudgment, valOut.report)│
│         # ★ v3.1 起,ONLY parsed === null 才强制 pending_human          │
│         # 其他 validation 失败 → 仅写 validation.failures[],不改 decision│
│                                                                        │
│       results.push(RuleCheckRunAudited { ... })                        │
│                                                                        │
│     ── short-circuit 触发检查                                          │
│     trigger = parsed.rule_judgments.find(rj =>                         │
│       rule.canBlock !== false AND rj.decision === "blocked")           │
│     if trigger:                                                        │
│       shortCircuitedAt = { stepOrder, byRuleId: trigger.ruleId }       │
│       stepCalls.last.triggeredShortCircuit =                           │
│         { byRuleId, reason: "canBlock+blocked" }                       │
└──────────────────────────────┬─────────────────────────────────────────┘
                               ▼
┌─────────────── Stage F: aggregate + terminal ──────────────────────────┐
│   baseAggregate = aggregateDecision(results.map(r => r.finalDecision)) │
│       # cascade: blocked > pending_human > passed > not_started        │
│   aggregate = { ...baseAggregate,                                       │
│                 terminal: shortCircuitedAt !== null,                    │
│                 terminalAtStep: shortCircuitedAt?.stepOrder }           │
└──────────────────────────────┬─────────────────────────────────────────┘
                               ▼
┌─────────────── Stage G: persist ───────────────────────────────────────┐
│   for each run in results:                                              │
│     filesystemRunStore.writeRun(run)                                    │
│       → data/rule-check-runs/<YYYYMMDD>/<runId>.json                    │
│       → append index.jsonl entry                                        │
│   filesystemRunStore.writeBatch(batch)                                  │
│     → data/rule-check-runs/batches/<batchId>.json                       │
│                                                                         │
│   ★ Neo4j 写回是被禁止的(SPEC §2 Non-goals)                            │
│   持久化失败 → rcWarn 记录,但不抛(batch 仍返回)                       │
└──────────────────────────────┬─────────────────────────────────────────┘
                               ▼
                  RuleCheckBatchRunAudited
```

### 4.1 Path C 的语义与字段对齐

- **stepCalls**: 长度 = `groupedSteps` 个数(被短路跳过的 step 也保留一格,`shortCircuited: true` + `llmRaw: null` + `promptProvenance: null`)。
- **results**: 长度 = 全部 active rule 数。被短路掉的 rule 也产生一条 `RuleCheckRunAudited`(`decision: "not_started"`, `overrideReason: "short_circuit:step_<N>:rule_<id>"`), 这样 matrix / aggregate 维度永不缺格。
- **terminal/terminalAtStep**: 由 orchestrator deterministic 写, LLM **不再** 自己声明 `final_output.terminal`(v3 起 Path C 下 LLM 不返 `final_output` 字段,因为每个 step 单独调用,看不到全局)。
- 每个 `RuleCheckRunAudited.batchId` = 共同的 `batch.batchId`。`runId` 唯一(UUIDv7)。
- **`ontologyApiTrace`**: 同一个 `OntologyApiTraceEntry[]` 数组,被批 batch 内所有 results 与 batch 自身共享(by reference)。落盘时每条 run JSON 与 batch JSON 都各自展开。审计字节因此略冗余, 但保证 per-run 独立可读。
- **`prompt`** 字段格式: `"[system]\n<focusing-msg>\n\n[user]\n<resolved prompt>"`(Stage E live 路径设的);短路跳过路径下 prompt 留空字符串。

### 4.2 错误模式

| 故障 | 行为 |
|---|---|
| `ONTOLOGY_API_BASE` 缺失 | Stage 起手就 throw |
| `candidateId` / `jobRef` 缺失 | Stage 起手就 throw |
| 候选人没 Resume | Stage B `loadMatchResumeRuntimeInput` throw |
| Ontology API 单次 fetch 失败(Stage C 内) | `rcWarn` 记录, 跳过该 fetch, **不中断**;下游 rule 没拿到 instance 时,evidence-grounded 会 fail |
| LLM 调用失败 / 流式断开 (`LLMUnreachableError` 或其他) | 该 step 内所有 rule → `buildFallbackRun`(decision = `pending_human`, overrideReason = `llm_unreachable:...` / `llm_unknown_error:...`); **不影响后续 step** |
| LLM 返回非 JSON / 不符 schema | 同上 fallback;`stepCalls` 仍记 promptProvenance + llmRaw(用来追问"那一次到底返回了啥") |
| 单条 rule_judgment Zod 解析失败 | `parsedJudgment = null` → `finalDecision = pending_human`(`overrideReason: "llm_output_unparseable: ..."`);其他 judgment 不受影响 |
| 文件系统持久化失败 | `rcWarn` 不抛,run 返回内存对象(但 `auditPath` 为 undefined) |

### 4.3 LLM 客户端要点(`lib/rule-check/llm-client.ts`)

- 总是 **streaming**(`stream: true`)。`stream_options: { include_usage: true }` 保证最后一帧带 `prompt_tokens` / `completion_tokens`。
- 通过 `rcInfo("llm", "first_byte" / "stream_end")` 区分"代理在首字节前断"(常见 504)还是"流中途断"。
- `response_format: { type: "json_schema", strict: true, schema: input.jsonSchema ?? MatchResumeEvalEnvelopeJsonSchema }`。**生产用 `StepResultJsonSchema`**(`output-schema-audited.ts` 从 `lib/ontology-gen/v4/envelope-schema.ts` 中 re-export 的 `StepResultJsonSchemaInternal`,等价于 envelope 的 `step_results.<key>` 子 shape)。
- 失败时一次性 retry(`status === 429` 或 5xx);终态包成 `LLMUnreachableError`。
- 合成一个 `syntheticResponse`(plain object): `{ model, choices:[{message:{content},finish_reason,logprobs?}], usage }` 写进 `llmRaw.response`。**重要**:OpenAI SDK 原始返回是 class instance, React Server Component 不能跨 RSC 边界——必须 JSON 化。
- logprobs 默认关。`RULE_CHECK_LOGPROBS=1` 打开;部分 provider(kimi)开 logprobs 会卡, 因此 composite 给了 degraded 路径。

---

## 5. 审计存储 — Filesystem RunStore

文件: `lib/rule-check/store/filesystem.ts`。

```
data/rule-check-runs/
├── 20260513/                       ← YYYYMMDD 子目录
│   └── <runId>.json                ← 一条 RuleCheckRunAudited(per-rule)
├── batches/
│   └── <batchId>.json              ← 一条 RuleCheckBatchRunAudited(per-batch)
└── index.jsonl                     ← append-only,每行一个 RunIndexEntry
```

### 5.1 `RunIndexEntry`(`store/index.ts`)

```ts
{ runId, batchId?, timestamp, date /* YYYYMMDD */, client, actionRef, ruleId, candidateId, decision, path }
```

`index.jsonl` 是廉价查询层 —— 所有 list / filter 用流式 readline + in-memory 过滤(POSIX O_APPEND 写,保证 append 原子)。

### 5.2 `RunStore` 接口(可插拔)

```ts
interface RunStore {
  name: string;
  writeRun(run): Promise<string>;
  writeBatch(batch): Promise<string>;
  listRuns(query): Promise<RunIndexEntry[]>;
  getRun(runId): Promise<RuleCheckRunAudited | null>;
  getBatch(batchId): Promise<RuleCheckBatchRunAudited | null>;
}
```

`external.ts` 里挂着 `openSearchRunStore` / `clickHouseRunStore` 的 `NOT_IMPLEMENTED` 占位 —— 文档形,未实现。当 filesystem 撑不住(估计 ~10k runs 起), 实现接口换掉 import 即可。

### 5.3 ★ 禁止 Neo4j 写回(locked)

`simple-rule-check/store/neo4j.ts` 是历史文件,**不应使用**。Rule Check 是 read-only consumer,任何 audit 数据写进 Ontology API 都违反 SPEC §2 Non-goals。

---

## 6. UI 层 — `/rule-check/*` 与 `/dev/rule-check`

### 6.1 服务端动作 — 关键设计/约束

实现唯一源在 `lib/rule-check/server-actions.ts`。路由层 `app/rule-check/actions.ts` 与 `app/dev/rule-check/actions.ts` 只做 **thin async wrapper + 本地重声明 public 类型**。

> ⚠️ **Next.js 16 + Turbopack 的 `"use server"` transform 不接受 `export type { ... } from "..."` 的 re-export 语法** —— 它会把 type 名当成 runtime 引用,生成 ReferenceError。所以路由层的 `actions.ts` 必须 `export interface` / `export type =` 重声明所有公开类型。`lib/rule-check/server-actions.ts` 顶部把所有内部 type 注释成 "NOT exported";它们的 shape 与路由层 `app/rule-check/actions.ts` 的导出**手动保持同步**(代码注释里点名了这一点)。

服务端动作清单(同时给 routes 与组件用):

| 动作 | 用途 | 重量 |
|---|---|---|
| `runCheckBatch(opts)` | 调 `checkRules`, 返 `{ok:true, batch}` 或 `{ok:false, error}` | 重(发起一次 batch) |
| `replayRun(runId)` | 读旧 run, 用其 `input` 重新发起一次单 rule batch, **新 runId**, 旧 audit JSON 不动 | 重 |
| `listMatrixCells(input)` | 流读 `index.jsonl`, 按 `(ruleId, candidateId)` 去重保留最新, 返单元格列表 | 轻 |
| `listAggregateRuns(input)` | 流读 index, 排序 + slice + 简单聚合(`passedPct` / 等) | 轻 |
| `listAggregateBatches(input)` | 流读 index, 按 `batchId` 分组, 懒读各 batch JSON 取 `terminal` + `stepCalls` | 中(每 batch 一次 disk read) |
| `getRunPreview(runId)` | 读单 run JSON, 投影为 `RunPreview`(顶 3 decisive evidence + conclusion 段) | 中 |
| `getRunDetail(runId)` | 读单 run JSON, 整段返(用于 `/rule-check/runs/[runId]`)。**不**经 routes 层 `actions.ts`,只在 server component 内部调,以免大 payload 上 client | 重 |
| `getBatchSummary(batchId)` | 读 batch JSON, 投影成 `BatchSummary`:stepCalls slim + 按 step 分组的 rule 卡 + candidate/job overview | 重 |
| `listActiveRules(input)` | 调 `fetchAllRules`(走 Ontology API), 用于 rule 字典 + matrix 行 | 中(走网络) |

### 6.2 路由总览

| URL | 文件 | 备注 |
|---|---|---|
| `/rule-check` | `app/rule-check/page.tsx` | 列出 batches,左侧选 batch → 右 BatchPreview。"Run new batch" 按钮 → `/dev/rule-check`(新标签) |
| `/rule-check/matrix` | `app/rule-check/matrix/page.tsx` | rules × candidates 网格,默认 scope `(matchResume, 腾讯, RAAS-v1)`;Ontology API 不可达时,基于现有 cells 退化生成行 |
| `/rule-check/rules` | `app/rule-check/rules/page.tsx` | 静态规则字典(id / name / sourceText / canBlock / stepOrder) |
| `/rule-check/batches/[batchId]` | `app/rule-check/batches/[batchId]/page.tsx` | 单 batch:verdict + stepCalls + candidate/job overview + 按 step 分组的 rule 卡(`规则原文` + 3 段 rootCause)|
| `/rule-check/runs/[runId]` | `app/rule-check/runs/[runId]/page.tsx` | 单 rule judgment 的 **8 layers Prove 详情**:L1 Verdict / L2 Inference Chain / L3 Why / L4 Evidence ledger / L5 Counterfactuals / L6 ValidationLight / L7 Prompt+Response / L8 Ask Why。dev 环境 fallback 到 `MOCK_RUNS` 当 audit 文件缺失时 |
| `/rule-check/runs` | `app/rule-check/runs/page.tsx` | 308 redirect → `/rule-check`(legacy URL stability) |
| `/rule-check/candidates/[id]` | `...candidates/[id]/page.tsx` | 候选人时间线(目前是 MOCK_RUNS 演示, **未串实际数据**)|
| `/rule-check/audit` | `audit/page.tsx` | 合规导出 stub |
| `/rule-check/settings` | `settings/page.tsx` | 设置 stub |
| `/dev/rule-check` | `app/dev/rule-check/page.tsx` | engineering 表单 → `runCheckBatch`;实时显示 aggregate + per-rule 卡 + 折叠 batch JSON |

### 6.3 客户/服务端组件配对

每个路由的渲染分两层:

- **`page.tsx`**(server component)→ 拉数据 → 把 props 喂给
- **`*PageView.tsx`**(client component, `"use client"`)→ 包 `Shell`(`components/shared/Shell.tsx`)、`useApp()` 取 i18n → 内嵌
- **`*Content.tsx`**(具体 UI)

例如:
```
/rule-check/runs/[runId]/page.tsx  (server)
   → getRunDetail() / (dev) MOCK_RUNS fallback
   → <RunDetailPageView runId={..} run={..} />
        → <Shell crumbs={...} directionTag={t("rc_run_detail")}>
             <RunDetailContent run={..} />   ← 8 layers
```

### 6.4 i18n

`lib/i18n.tsx` 提供 `useApp()` → `t()`。所有 `rc_*` key 都在 `zh` / `en` 两份字典里(`rc_dashboard / rc_runs / rc_run_detail / rc_passed / rc_blocked / rc_pending_human / rc_not_started / rc_v_*` ...)。新增 string 要同时加到两份字典。

LeftNav(`components/shared/LeftNav.tsx`)里只有一个 `rule-check` 顶层入口,指向 `/rule-check`。

### 6.5 视觉资产

所有颜色 / 字号 / 圆角走 `app/globals.css` OKLCH 令牌(`--c-*`)。Decision 颜色映射(`/dev/rule-check` 内 `decisionColor()` 也用同一套):

| decision | bg / text |
|---|---|
| passed | `bg-ok-bg text-ok` |
| blocked | `bg-err-bg text-err` |
| pending_human | `bg-warn-bg text-warn` |
| not_started | `bg-surface text-ink-3` |

---

## 7. 类型字典(只列高频)

完整定义看 `lib/rule-check/types.ts` + `lib/rule-check/types-audited.ts`(后者是 audit-rich 主战场)。

### 7.1 `CheckRulesInput`

```ts
{
  actionRef: "matchResume",
  candidateId: string,         // required
  jobRef: string,              // required (matchResume 必须)
  scope: { client: string, department?: string },
  domain?: "RAAS-v1",
  ruleIds?: string[],          // 缺省 = 跑全部 active rule
  // env overrides
  apiBase?, apiToken?, openaiApiKey?, openaiBaseUrl?, llmModel?, timeoutMs?
}
```

### 7.2 `RuleDecision`

`"not_started" | "passed" | "blocked" | "pending_human"` —— 锁死四值, 无论 prompt / schema / TypeScript / UI 都一致。语义:

- `not_started`: rule 不适用 / 前置条件未满足 / 被短路跳过
- `passed`: 数据明确未触犯,可继续推荐
- `blocked`: 数据明确触犯,必须拦截
- `pending_human`: 数据不足 / 边界模糊 / LLM 输出无效, 必须人工

### 7.3 `RuleJudgmentAudited`(LLM 单条判定 + 校验后)

```ts
{
  ruleId: string,
  decision: RuleDecision,
  evidence: EvidenceAudited[],   // 含 fetchedInstanceIndex / decisive / grounded(后者由校验器写)
  rootCause: string,             // 中文 narrative,4 段(实际 3 段:rule 原文已经在 prompt 里)
  rootCauseSections: { dataObservation, contrastReasoning, conclusion },
  confidence: number,            // 已被 composite override
  nextAction: string,
  counterfactuals?: CounterfactualEntry[]
}
```

注意 v3 起 `rootCauseSections` 是**三段**(去掉了 `ruleRequirement`/【规则要求】, 因为规则原文已经在 batch 详情页显示一遍, 重复让 LLM 复述属冗余)。MVP `extractor.ts` 仍保留四段 prompt 文案,是**有意分歧**。

### 7.4 `RuleCheckRunAudited`(单 rule 的完整审计)

```ts
{
  runId: UUIDv7,
  batchId?: UUIDv7,                  // 同批次的 run 共享
  timestamp: Beijing ISO-8601,
  input: CheckRuleInput,
  fetched: { rule, instances },      // 该 run 看到的 rule + 全部 fetched instances 快照
  prompt: "[system]...[user]...",    // verbatim 拼出的 prompt 文本
  promptProvenance: { promptSha256, actionObjectSha256, generatePromptInput, resolvedAt },
  ontologyApiTrace: OntologyApiTraceEntry[],
  llmRaw: { model, response, inputTokens, outputTokens, latencyMs },
  llmParsed: RuleJudgmentAudited | null,
  validation: ValidationReport,      // ruleIdExists / evidenceGrounded / schemaValid / blockSemanticCheck / overallOk / failures[]
  confidenceBreakdown: { evidenceCountFactor, consistencyFactor, logprobScore|null, source: composite_full|composite_degraded },
  finalDecision: { decision, overrideReason? },
  humanOverrides?: HumanOverride[],   // 操作员 pending_human → passed/blocked 操作日志,待 UI 接
  askWhyHistory?: AskWhyEntry[],
  auditPath?: string                  // writeRun 落盘后填
}
```

### 7.5 `RuleCheckBatchRunAudited`

```ts
{
  batchId: UUIDv7,
  timestamp,
  input: CheckRulesInput,
  results: RuleCheckRunAudited[],
  aggregateDecision: { decision, triggeredRules: string[], terminal: boolean, terminalAtStep?: number },
  stepCalls: StepCallRecord[],       // 按 stepOrder 升序,跳过的 step 占位
  ontologyApiTrace: OntologyApiTraceEntry[],
  auditPath?: string
}
```

### 7.6 `StepCallRecord`

```ts
{ stepOrder, stepKey: "step_<N>", shortCircuited, startedAt: ISO|null,
  llmRaw: LLMRawResponse|null, promptProvenance: PromptProvenance|null,
  triggeredShortCircuit?: { byRuleId, reason: "canBlock+blocked" } }
```

### 7.7 Envelope SSOT

`lib/ontology-gen/v4/envelope-schema.ts` 是 envelope 形状的**唯一来源**:
- `MatchResumeEvalEnvelopeZod`(Zod runtime parser)
- `MatchResumeEvalEnvelopeJsonSchema`(给 OpenAI strict mode + `## 最终输出 JSON 结构` 渲染共享)
- `StepResultZod` / `StepResultJsonSchemaInternal`(单 step 子 shape, Path C 实际生产用)
- `RuleJudgmentZod` / `RuleJudgmentInEnvelope`

`lib/rule-check/output-schema-audited.ts` **只是 re-export** —— 不在这里维护 shape, 改动同步到上述 SSOT。

---

## 8. 关键扩展点 — 加规则 / 换 store / 换 LLM

### 8.1 加一条新规则

1. **写 prompt 那边**(`lib/ontology-gen/v4/...` + ontology repo): 让该 action 的 `actionSteps[].rules[]` 多出该 rule。`fetch-rules.ts` 自动捡到,UI / matrix / aggregate 自动出现。
2. **声明它需要的额外数据**(`lib/rule-check/rule-instance-map.ts::instancesNeededForRule`): switch case 加一条。能用现成的(Candidate / Resume / Application / Blacklist / Candidate_Expectation), 否则:
3. **扩 `InstanceSpec`** 与 `fetch-extra-instances.ts` 的 dispatch — 加一个 `kind: "..."` 分支 + 在 `fetch-instances.ts` 加 fetcher 函数。
4. **classification metadata** (`canBlock` / `requiredInstances`): 上游 Ontology Rule node 加上字段, `fetch-rules.ts::deriveCanBlock`/`deriveRequiredInstances` 自动读到;在 ontology repo 未补字段前, 至少把 `severity` 设对(`"blocker"` / `"advisory"`)。
5. (可选)在 Stage E 短路语义不合适 → 改 `canBlock` 派生函数或 short-circuit 触发条件(`canBlock !== false ∧ decision === "blocked"`)。

> MVP `lib/simple-rule-check/rule-instance-map.ts` **未映射** 的规则会直接 throw;full impl **未映射** 的规则会被静默接受(`return null`, 只跑 Job+Resume 上下文)。两者差异是有意的。

### 8.2 换审计存储

实现 `RunStore` 接口(`store/index.ts`), 在 `orchestrator/all-in-one.ts::persistBatch` 把 `filesystemRunStore` 换掉。`external.ts` 已经留好 OpenSearch / ClickHouse 占位(只是抛 NOT_IMPLEMENTED, 还没实现)。server-actions 里的 `filesystemRunStore.getRun/getBatch/listRuns` 引用要一起切。**禁止改成写 Neo4j**。

### 8.3 换 LLM provider

`OPENAI_BASE_URL` + `OPENAI_MODEL` env 即可切到任意 OpenAI-兼容 endpoint。`llm-client.ts` 唯一硬要求:
- `response_format: { type: "json_schema", strict: true }` 兼容
- streaming 兼容(`stream: true` + `stream_options.include_usage`)
- 可选 `logprobs: true`(无支持则 composite 自动降级)

`OPENAI_TIMEOUT_MS=600000` 默认 10 分钟;Path C 之所以诞生, 就是 kimi via new-api 在 Path B 单 envelope 输出 ~10–15K tokens 时 504 —— 单 step 子 shape 把响应控制在 ~1500 tokens 以下。

### 8.4 加一个 UI 路由

仿照已有路由的 server / client 配对:

```
app/rule-check/<name>/page.tsx              ← server component, 调 server-actions
   → <NameOfPageView ...props />            ← components/rule-check/<Name>PageView.tsx (client)
        <Shell ...><NameOfContent ...></Shell>
```

i18n 要同步加 `rc_<key>`(`lib/i18n.tsx` 两份字典都要)。

服务端动作:
- 优先放进 `lib/rule-check/server-actions.ts`(实现真值)
- 再在 `app/rule-check/actions.ts` 加 thin wrapper + **本地重声明** public 类型(见 §6.1 Turbopack 限制)

---

## 9. 调试 / 排错

### 9.1 `RULE_CHECK_DEBUG=1`

打开后 `lib/rule-check/debug.ts` 的 `rcDebug` 全部到 stderr,格式:
```
[rule-check:<scope>] +12345ms DEBUG  message  key=value key2=value2
```

scope 一览:`orchestrator` / `fetch-rules` / `fetch-extra` / `runtime-input` / `prompt-build` / `llm` / `ontology` / `validation` / `confidence` / `store`。

`rcInfo` 始终开,记录 stage 起止 + tookMs;`rcWarn` 是异常但不致命的。**stdout 永远干净**(`pretty` CLI 输出 + `--output json` 的纯 JSON), stderr 是日志,所以 `2>/dev/null` 也能跑 pipe。

### 9.2 看 batch 完整 audit

```bash
# CLI
npm run rule-check -- --candidate C-MVP-001 --client 腾讯 --job JR-MVP-TENCENT-001 --output json > /tmp/batch.json

# UI
浏览器 → /rule-check → 点最新一条 batch 卡 → 进入 /rule-check/batches/<batchId>
进一步钻取单 rule → /rule-check/runs/<runId>
```

文件位置:
```
data/rule-check-runs/batches/<batchId>.json
data/rule-check-runs/<YYYYMMDD>/<runId>.json
```

### 9.3 prompt 调试

```bash
npm run dev:dump-match-resume-prompt
# 落到 data/dev/match-resume.templated.md(无 runtime 替换的 templated 形)
#       data/dev/match-resume.section-stats.json(每段字符 / token 数)
```

或直接打开 `/rule-check/runs/<runId>`,Layer 7 PromptPanel 三标签:resolved / source actionObject / raw response。

### 9.4 常见症状

| 症状 | 看哪里 |
|---|---|
| `LLMUnreachableError: stream returned no content` | LLM 代理在首字节前断;`rcInfo` 的 `first_byte` 没出现 → 代理 504。换 model / 降 prompt 大小 |
| `envelope_invalid` 或 `schema_invalid:...` | LLM 输出不符 `StepResultJsonSchema`;看 `llmRaw.response.choices[0].message.content` 排查 |
| 所有 rule 都 `pending_human` 且 `overrideReason: validation_failed` | 你用的是 **MVP** 不是 full。Full v3.1 起不再因 validation 强制 override(只 unparseable 触发) |
| matrix 单元格颜色变 ⚫ `not_started`(未触发) | rule 被短路了, 或 LLM 真的判 `not_started`;到 `/rule-check/batches/<id>` 看 `terminalAtStep` |
| `Ontology API unavailable` 报错 | `ONTOLOGY_API_BASE` 不可达 / token 失效;`/rule-check/matrix` 与 `/rule-check/rules` 都有 graceful degrade(空列表) |
| Turbopack server-action 起 `ReferenceError: SomeType is not defined` | 在 `app/.../actions.ts` 用了 `export type { Foo } from "..."` re-export — 改成本地 `export interface Foo {}` 重声明(见 §6.1) |
| `not iterable` 之类的奇怪报错来自 audit JSON | 老版本 audit JSON 缺新字段(如 `stepCalls`、`rootCauseSections`);要么删旧文件,要么往读取处加兼容防御 |

### 9.5 数据完整性

- audit 写入是 best-effort: orchestrator 顶上 try/catch 包了 `persistBatch`, 写失败只 warn, batch 仍正常返回。
- `index.jsonl` 仅 append,无 GC;长期跑要定期 archive。
- 同一 batch 重跑会产生新 `batchId` + 新 `runId[]` —— `replayRun` 走同样路径, 不动旧文件。

---

## 10. 关键依赖关系图

```
                ┌─────────────────────────┐
                │ lib/ontology-gen/...    │ 上游(prompt + HTTP + 类型)
                │  - client.ts            │
                │  - fetch.ts             │
                │  - compile/filter.ts    │
                │  - v4/                  │
                │    - generate-prompt    │
                │    - fill-runtime-input │
                │    - assemble-v4-4      │
                │    - envelope-schema ★  │ ← SSOT for envelope
                │    - runtime-adapters   │
                └────────┬────────────────┘
                         │ (verbatim consume)
                         ▼
┌─────────────────────────────────────────────────────┐
│ lib/rule-check/                                     │
│  - prompt/build.ts ────uses──→ generatePrompt       │
│                          ──→ fillRuntimeInput       │
│  - llm-client.ts   ──jsonSchema─→ envelope-schema   │
│  - output-schema-audited.ts (re-export)             │
│  - fetch-rules.ts  ────uses──→ fetchAction          │
│                          ──→ applyClientFilter      │
│  - fetch-instances.ts ────uses──→ client.getJson    │
│  - store/ontology-trace-recorder.ts (拦截层)        │
│  - orchestrator/all-in-one.ts ── 编排核心            │
│  - validation/* (4 个 check + index 聚合)            │
│  - confidence/composite.ts                          │
│  - store/filesystem.ts                              │
│  - aggregate-decision.ts                            │
│  - server-actions.ts                                │
└────────┬────────────────────────────────────────────┘
         │
         ├──── checkRules() ──── scripts/rule-check.ts (CLI)
         │                        │
         │                        └─── app/dev/rule-check/(engineering UI)
         │
         └──── server-actions ──── app/rule-check/(commercial UI)
                                    │
                                    └── components/rule-check/(view + atoms)
```

`lib/rule-check/` 与 `lib/simple-rule-check/` 没有 import 关系(除了 `lib/rule-check/types.ts` 顶部 re-export MVP 的几个基础类型)。

---

## 11. 与 MVP 的并行结构 — 一一对照

| 目录 / 文件 | MVP (`lib/simple-rule-check/`) | Full (`lib/rule-check/`) | 差异说明 |
|---|---|---|---|
| `index.ts` | 同 ABI | 同 ABI + audited 类型 | full 把 audit 类型一起 export 出来 |
| `checker.ts` | `checkRule → singleCallOrchestrator` | `checkRules → allInOneOrchestrator` + `checkRule` 是过滤糖 | 入口拓扑不同 |
| `types.ts` | 全套基础类型自定义 | re-export MVP + `FetchedRuleClassified` | 不重复造 |
| `types-audited.ts` | 无 | ★ audit-rich 全套 | full 独有 |
| `output-schema.ts` | 自己定义 `RuleJudgmentJsonSchema` | re-export 自 v4 envelope-schema | full 走 SSOT |
| `llm-client.ts` | 非 streaming, 默认 strict json_schema | streaming, 默认 envelope schema, RULE_CHECK_LOGPROBS 旋钮 | 实现差异大 |
| `fetch-rules.ts` | 不派生 canBlock | 派生 canBlock / requiredInstances | full 加分类元数据 |
| `fetch-instances.ts` | 走原始 `client.getJson` | 走 `tracedGetJson` → 写 ontologyApiTrace[] | trace 是 full 独有 |
| `fetch-extra-instances.ts` | 无(orchestrator 内 inline) | ★ 独立模块: 去重 + 稳定排序 + 并发 | full 抽出 |
| `rule-instance-map.ts` | 未映射 → throw | 未映射 → return null | 哲学差异 |
| `orchestrator/*` | `single-call.ts` 8 阶段 / `all-in-one.ts` throw | `all-in-one.ts` Path C 7 阶段(A-G)/ `single-call` 没有 | 完全两套 pipeline |
| `prompt/*` | `extractor.ts` 手写 / `full.ts` throw | `build.ts` 直接用 generatePrompt / `runtime-input-loader.ts` / `focusing-system.ts` | 完全两套 prompt |
| `validation/*` | 同 4 个 check 模块 | + 写 `ev.grounded` in-place | 行为更细 |
| `confidence/*` | `self-reported.ts` + `composite.ts`(都存在) | 只 `composite.ts`(`self-reported.ts` 没必要) | full 不要 pass-through |
| `store/*` | `filesystem.ts` 简单写 + `neo4j.ts` (禁用) | `filesystem.ts` 带 batches/ + `external.ts` 占位 + `ontology-trace-recorder.ts` | full 多审计能力 |
| `aggregate-decision.ts` | 无(只有单 run) | ★ cascade 聚合 | full 独有 |
| `instance-overview.ts` | 无 | ★ UI overview 卡数据 picker | full 独有 |
| `server-actions.ts` | 无 | ★ UI 服务端动作集合 | full 独有 |
| `debug.ts` | 用 `process.stderr.write` | ★ rcLog 框架 + 时间戳 | full 系统化 |

---

## 12. 跟生产 / 接入相关的注意事项

### 12.1 与 matchResume executor agent 的契约

**envelope shape 是共享契约**。`lib/ontology-gen/v4/envelope-schema.ts` 改动会同时影响:
- (此仓) `lib/rule-check/`(消费)
- (外部 Inngest worker) `matchResume` executor agent(也消费)

任何 schema 变更必须 coordinated。SPEC §15 locked decision: 走 `schemaVersion: "v4-eval"` 字段或 feature flag。

Path C 之所以可以**独立**部署:它把全 envelope 拆成 per-step `{ rule_judgments[] }`,实现上不要求 executor agent 同步改。但若 executor agent 仍消费完整 envelope(Path B 形态), 那它要自己把 N 个 step result 合并。

### 12.2 KEEP/DROP/PAUSE 三分支

本仓库的代码**到 `RuleCheckBatchRunAudited` 为止**。下游(KEEP → Robohire / DROP → blacklist / PAUSE → humanTask)在 AO 端 `matchResumeAgent` 内做, 见:
- [rule-check-end-to-end-workflow.md](../rule-check-end-to-end-workflow.md)(根目录,详细 KEEP/DROP/PAUSE 设计)
- 入口字段: `aggregateDecision.decision`(对外即"overall_decision")
- 短路标志: `aggregateDecision.terminal` / `terminalAtStep`(给 UI / audit;executor 一般不依赖)

### 12.3 域 (`domain`)

- 缺省 `RAAS-v1`。
- SPEC 早期版本提"TEST-RAAS-v1 isolation"已经废除(`§15 Decision log`)。审计落本地, blast radius = `ONTOLOGY_API_BASE` 指向的实例。
- 生产 / 测试切换靠改 `.env.local` 的 `ONTOLOGY_API_BASE` + `ONTOLOGY_API_TOKEN`。

---

## 13. 已知 gap / Roadmap(代码层视角)

| 项 | 现状 | 备注 |
|---|---|---|
| `humanOverrides[]` 字段 | 类型定义在 `types-audited.ts` 内, **UI 与 store 未接入** | 未来要让操作员在 `/rule-check/runs/<id>` 把 `pending_human` 转 `passed` / `blocked` |
| `askWhyHistory[]` 字段 | 同上 | `AskWhyChat.tsx` 是占位组件 |
| `counterfactuals[]` | LLM 已经能输出, UI `CounterfactualsList.tsx` 也已渲染 | 没有"把 counterfactual 跑成新 run"的 verify 闭环 |
| External RunStore | `external.ts` 内 OpenSearch / ClickHouse stub | filesystem 撑到 ~10k runs 没问题, 之后再选 |
| `/rule-check/audit` | UI stub, 无后端 | 导出 PDF / XLSX / signed JSON bundle 都是 placeholder |
| `/rule-check/settings` | UI stub, 不持久化 | 模型 / threshold / retention 都是 useState |
| `/rule-check/candidates/[id]` | 读 `MOCK_RUNS` 演示, 不读真实 audit | 接 `filesystemRunStore.listRuns({ candidateId })` 即可 |
| Path B(单 envelope)/ Path A(per-rule 并发) | 代码注释里多处提到, 但**当前生产路径只有 Path C** | 如果 LLM provider 支持大输出, 重启 Path B 收益:1 次 LLM call, 拿到 `final_output.notifications`(PAUSE 路径所需)|
| `notifications` / PAUSE 路径下游 | Path C v1 不带 `final_output.notifications` | 等 ontology rule classifier 加 `notificationTemplate` 元数据, 或加 post-LLM 合成器 |
| `step_4 generateMatchResult`(tool-only step) | 自然跳过 | Robohire 评分接入要单独搞 |
| Rule node `can_block` / `required_instances` 字段 | ontology repo 还没正式落 | `fetch-rules.ts` 已经能读, 也回退到 `severity` 派生 |
| logprob composite 全场可用 | 取决于 provider | kimi 经常挂, 默认关; gpt-4o / Claude 一般可开 |
| `lib/simple-rule-check/` 维护策略 | **冻结**, 只接 schema-drift / 安全补丁 | A/B 对比用 |

---

## 14. 文件清单 — 改动时谁动谁

- 改 prompt 文案 / 输出 schema → `lib/ontology-gen/v4/envelope-schema.ts` + `assemble-v4-4.ts`(SSOT,影响 generatePrompt + rule-check + executor)
- 改 rule → instance 映射 → `lib/rule-check/rule-instance-map.ts` + `lib/simple-rule-check/rule-instance-map.ts`(MVP 单独维护, 不会自动同步)
- 改 LLM 调用语义(timeout / retry / streaming / logprobs) → `lib/rule-check/llm-client.ts`
- 改编排(短路条件 / 阶段 / 错误 fallback) → `lib/rule-check/orchestrator/all-in-one.ts`
- 改校验(rule_id / evidence / block-semantic / schema) → `lib/rule-check/validation/*.ts`
- 改置信度公式 → `lib/rule-check/confidence/composite.ts`
- 改 aggregate cascade → `lib/rule-check/aggregate-decision.ts`
- 改审计存储 → `lib/rule-check/store/*`
- 加 UI 路由 → `app/rule-check/<name>/` + `components/rule-check/<Name>*` + `lib/rule-check/server-actions.ts` + `lib/i18n.tsx`
- 加 dev CLI 入口 → `scripts/...ts` + `package.json:scripts`
- 加 env 变量 → 在 `.env.local`(并在 `lib/rule-check/llm-client.ts` 或 `debug.ts` 解析)

---

## 15. 词汇表(避免误读)

| 词 | 在本代码里指 |
|---|---|
| **batch** | 一次 `checkRules(input)` 调用; 包含若干 per-rule run |
| **run** | 一个 rule 一次评估的审计记录(`RuleCheckRunAudited`) |
| **step** | matchResume action 的 `actionSteps[].order`(1-based, 1/2/3/4...);只有 `rules.length > 0` 的 step 在 Path C 下被迭代 |
| **judgment** | LLM 对单个 rule 的判定输出(`RuleJudgmentAudited`) |
| **decision** | 4 值之一: `not_started` / `passed` / `blocked` / `pending_human` |
| **finalDecision** | 经 `computeFinalDecision` 后的最终值(v3.1 起几乎等同 LLM 自报,除非 parsed === null) |
| **aggregateDecision** | 整个 batch 的 cascade 聚合(blocked > pending > passed > not_started) |
| **terminal** | 本 batch 是否触发短路(orchestrator 派生, 非 LLM 自报) |
| **canBlock** | rule 是否允许把整个 batch 判 `blocked`;来自 ontology 字段或 `severity` 兜底 |
| **short-circuit** | 某 step 内出现 `canBlock !== false ∧ decision === "blocked"` 后,跳过后续 step 的 LLM 调用,被跳 rule 合成 `not_started` |
| **provenance** | promptSha256 / actionObjectSha256 / runtimeInputDigest;用于 drift 检测 |
| **grounded** | evidence 是否在 fetched 数据中 byte-equal 命中(校验器 in-place 写 `ev.grounded`)|
| **decisive** | LLM 自报这条 evidence 是否驱动了判定(只用于 UI top-3 抽取 / consistency 因子) |
| **focusStep** | `buildEvalPrompt` 的可选参数;Path C 下让 `generatePrompt` 只渲染单 step 的 prompt 内容 |

---

## 16. FAQ — 几个高频被问

**Q: 为什么 `lib/rule-check/` 不复用 `lib/simple-rule-check/` 的 fetch / validation 代码?**
A: 故意的(SPEC §15 locked)。MVP 是冻结基线, sibling-copy 让 full 单独演进, 同时保留 A/B 能力。代价是少量重复, 收益是 MVP 不会被 full 的修改 break。

**Q: 为什么 Stage A 用 `applyClientFilter` 而 LLM prompt 那边也用一次?**
A: Stage A 决定 *哪些 rule 进入 active set*(影响 `groupedSteps` / `instancesNeededForRule` 调度); prompt 渲染走 `generatePrompt`(也内部 client-filter)只决定 *prompt 文本里出现的规则原文*。两者过滤逻辑应等价(`scripts/verify-client-filter.ts` 周期校验)。

**Q: 为什么 `terminal` 字段不让 LLM 报?**
A: Path C 下 LLM 看不到全局(只调单 step), 无法判断是否短路;orchestrator deterministic 写更安全 + 可解释。SPEC §15 已 lock。

**Q: `evidenceGrounded === false` 但 `finalDecision === "passed"` 怎么办?**
A: v3.1 起这是允许的状态。validation 已退为 informational, LLM 是 judge, code 不替它做决定。要拦截这种情况, 让人工 review(`validation.failures[]` UI 有 ValidationLight 警示灯)。

**Q: 我能从浏览器 `/rule-check` 里直接发起一次 batch 吗?**
A: 不能, 现在 "Run new batch" 按钮跳到 `/dev/rule-check`(engineering 表单)。如果要做 in-line 表单, 改 `AggregateContent.tsx` 的按钮 + 复用 `runCheckBatch` server action。

**Q: `data/rule-check-runs/` 越来越大怎么办?**
A: 目前没自动 GC。临时方案:archive 旧的 `<YYYYMMDD>/` 目录,重写 `index.jsonl`(过滤掉 path 不存在的)。长期方案:实现 `external.ts` 里的 ClickHouse / OpenSearch store。

**Q: 我看到 `RuleCheckRunAudited.fetched.instances` 在 batch 内的所有 run 都一模一样, 不是浪费空间吗?**
A: 是。设计取舍:per-run 自包含 → 每个 run JSON 单独打开就完整可读, 不需要 join batch JSON。`ontologyApiTrace` 同理。整 batch 写 ≈ 100-500KB,目前能接受。

---

**END.** 上述每一条都从代码里实际读出, 截至 2026-05-14。改动可能让某些细节漂移; 看到不一致以代码为准,并欢迎 PR 修这份文档。
