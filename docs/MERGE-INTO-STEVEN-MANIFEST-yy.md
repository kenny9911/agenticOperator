# yy Rule-Check Integration — Manifest (`-yy` namespace)

> 本文档面向 steven 分支的接手者。它描述一个**整体加 `-yy` 后缀**引入到 steven 分支的 rule-check 实现 —— 让两套独立的 rule-check 实现在同一仓库里**并存**,future 阶段再决定取舍。

---

## 1. 一句话定义

`-yy` 命名空间是一套**独立于 steven 既有 `rule-check`** 的 rule-check 实现:
- 通过 `generatePrompt` + `fillRuntimeInput` 把 ontology API 拉到的 action / rule 定义喂给 LLM,**Path C 编排** — 按 `actionStep` 串行调多次 LLM,每次出该 step 的 `rule_judgments[]`,触发 red-line `blocked` 时短路。
- 配套审计 ledger(`data/rule-check-yy-runs/`)、Prove-UI(`/rule-check-yy`)、CLI(`npm run rule-check-yy`)、MVP 基线(`lib/simple-rule-check-yy/`)。
- 跟 steven 既有 `rule-check`(per-rule evidence builder + Prisma audit writer + matchResume agent 接入)**完全独立** —— 路径不撞、import 不撞、UI 不撞。

**关系图**:

```
kenny9911/steven (合入后)
├── 既有(steven 的)
│   ├── app/rule-check/        ◄── /rule-check 路由 (steven)
│   ├── lib/rule-check/        ◄── runner / evidence/* / prisma-audit-writer / yeyang-runner / ...
│   ├── components/rule-check/ ◄── ScenarioMatrix / GraphView / RuleCheckContent / ...
│   └── app/api/rule-check/    ◄── 服务端 API routes
│
└── 新加(yy 的,-yy 后缀)
    ├── app/rule-check-yy/         ◄── /rule-check-yy 路由 (yy, 9 pages)
    ├── lib/rule-check-yy/         ◄── Path C orchestrator / validation / store / ...
    ├── lib/simple-rule-check-yy/  ◄── MVP frozen baseline (single-rule single-call)
    ├── components/rule-check-yy/  ◄── AggregateContent / MatrixContent / Prove atoms
    ├── app/dev/rule-check-yy/     ◄── engineering preview
    └── scripts/{rule-check-yy, simple-rule-check-yy, simple-rule-check-yy-seed}.ts
```

---

## 2. 新引入的命名空间(完整清单)

### 2.1 路由(`app/`)

| URL | 文件 | 作用 |
|---|---|---|
| `/rule-check-yy` | `app/rule-check-yy/page.tsx` | Aggregate(每行 = batch);左侧 BatchList + 右侧 BatchPreview。"Run new batch" → `/dev/rule-check-yy` |
| `/rule-check-yy/matrix` | `app/rule-check-yy/matrix/page.tsx` | rules × candidates 网格 |
| `/rule-check-yy/rules` | `app/rule-check-yy/rules/page.tsx` | 静态规则字典(id / name / sourceText / canBlock / stepOrder) |
| `/rule-check-yy/batches/[batchId]` | `app/rule-check-yy/batches/[batchId]/page.tsx` | 单 batch 详情:verdict + stepCalls + per-step rule 卡 |
| `/rule-check-yy/runs/[runId]` | `app/rule-check-yy/runs/[runId]/page.tsx` | 单条 rule judgment 的 **8-layer Prove 详情** |
| `/rule-check-yy/runs` | `app/rule-check-yy/runs/page.tsx` | `redirect("/rule-check-yy")` (307) — legacy URL 兼容 |
| `/rule-check-yy/candidates/[id]` | `app/rule-check-yy/candidates/[id]/page.tsx` | 候选人时间线(目前 MOCK_RUNS demo,未串实际数据) |
| `/rule-check-yy/audit` | `app/rule-check-yy/audit/page.tsx` | 合规导出 stub |
| `/rule-check-yy/settings` | `app/rule-check-yy/settings/page.tsx` | 设置 stub |
| `/dev/rule-check-yy` | `app/dev/rule-check-yy/page.tsx` | engineering 表单 → `runCheckBatch`;实时显示 aggregate + per-rule 卡 |
| `/dev/simple-rule-check-yy` | `app/dev/simple-rule-check-yy/page.tsx` | MVP 单条 rule 预览 |

`app/rule-check-yy/actions.ts` 是所有 `/rule-check-yy/*` 服务端动作的 "use server" 入口,thin re-export 自 `lib/rule-check-yy/server-actions.ts`(并 LOCAL 重声明 public 类型 —— 这是 Turbopack server-action 类型 re-export 的解法,详见 [RULE-CHECK-DEV-GUIDE-yy.md §6.1](RULE-CHECK-DEV-GUIDE-yy.md))。

### 2.2 库(`lib/`)

**Full impl** `lib/rule-check-yy/`(29 个 TS 文件):

- 入口:`index.ts`(ABI: `checkRule` / `checkRules` + audited 类型 re-export)、`checker.ts`、`server-actions.ts`
- 类型:`types.ts`、`types-audited.ts`、`output-schema-audited.ts`(re-export `lib/ontology-gen/v4/envelope-schema.ts` 的 SSOT)
- 数据获取:`fetch-rules.ts`、`fetch-instances.ts`、`fetch-extra-instances.ts`、`rule-instance-map.ts`、`instance-overview.ts`
- 编排:`orchestrator/all-in-one.ts`(★ Path C 核心)、`orchestrator/index.ts`
- Prompt:`prompt/build.ts`(消费 `generatePrompt` → `fillRuntimeInput` → SHA-256 provenance)、`prompt/focusing-system.ts`、`prompt/runtime-input-loader.ts`
- 校验:`validation/{schema,rule-id,evidence-grounded,block-semantic,index}.ts`
- 置信度:`confidence/composite.ts`、`confidence/index.ts`
- 存储:`store/filesystem.ts`(`data/rule-check-yy-runs/` JSONL index)、`store/ontology-trace-recorder.ts`(每个 Ontology GET 进 trace)、`store/external.ts`(OpenSearch / ClickHouse stubs)、`store/index.ts`
- 辅助:`aggregate-decision.ts`、`llm-client.ts`(streaming + strict json_schema + logprobs env)、`debug.ts`

**MVP frozen baseline** `lib/simple-rule-check-yy/`(22 个 TS 文件):

- `checker.ts`(单 rule 单 call,`checkRules` 抛 Error)、`index.ts`、`types.ts`、`output-schema.ts`、`llm-client.ts`
- `orchestrator/single-call.ts`(8 阶段 pipeline,无 trace、无 stepCalls)
- `prompt/extractor.ts`(★ 手写 system + user,单 rule 抽出,含 4 段 rootCause 规范)
- `validation/*`(同结构,但不写 `ev.grounded`)
- `confidence/{self-reported,composite,index}.ts`
- `store/filesystem.ts`(`data/simple-rule-check-yy-runs/`,按日期分目录,无 index.jsonl)+ `store/neo4j.ts`(stub:throw `"neo4jRunStore is not implemented in MVP"` —— Neo4j 写回**锁死禁止**)
- `rule-instance-map.ts`、`fetch-rules.ts`、`fetch-instances.ts`

### 2.3 组件(`components/rule-check-yy/`,29 个 TSX)

- Page views:`AggregatePageView` / `MatrixPageView` / `BatchDetailPageView` / `RunDetailPageView` / `RuleLibraryPageView`(server → "use client" → 包 `Shell` → 内嵌 Content)
- Content:`AggregateContent` / `MatrixContent` / `BatchDetailContent` / `RunDetailContent` / `RuleLibraryContent` / `CandidateTimelineContent` / `AuditContent` / `SettingsContent`
- Mock:`mock.ts`(MOCK_RUNS — 3 条样例 `RuleCheckRunAudited`,dev fallback)
- Atoms(Prove UI 原子):`DecisionBadge` / `InferenceChain` / `FactCard` / `EvidenceCard` / `CounterfactualsList` / `ConfidenceRing` / `LogprobInlineChart` / `ValidationLight` / `RootCauseTimeline` / `PromptPanel` / `ResponsePanel` / `AskWhyChat` / `MatrixGrid` / `BatchPreview` / `RunsList` / `RunsPreview` / `RunsDashboard` / `ReplayButton` / `formatElapsed`

### 2.4 CLI(`scripts/`)

- `scripts/rule-check-yy.ts` — `npm run rule-check-yy`,调 `checkRules()`,打印 batch 结果 / json / decision-only
- `scripts/simple-rule-check-yy.ts` — `npm run simple-rule-check-yy`,单 rule MVP CLI
- `scripts/simple-rule-check-yy-seed.ts` — `npm run simple-rule-check-yy:seed`,种 14 个 RAAS-v1 测试实例(也是 `npm run rule-check-yy:seed` 的别名)

### 2.5 运行时审计存储(`data/`,`.gitignore`'d)

- `data/rule-check-yy-runs/<YYYYMMDD>/<runId>.json` — per-rule run
- `data/rule-check-yy-runs/batches/<batchId>.json` — per-batch
- `data/rule-check-yy-runs/index.jsonl` — append-only 索引
- `data/simple-rule-check-yy-runs/<YYYYMMDD>/<runId>.json` — MVP

### 2.6 文档(`docs/`)

| 文件 | 内容 |
|---|---|
| `docs/RUNTIME-RULE-CHECKER-SPEC-yy.md` | 设计 SPEC(原始决策日志)。1700+ 行,记录 locked decisions |
| `docs/GENERATE-PROMPT-USER-GUIDE-yy.md` | 上游 `generatePrompt` 用户文档(rule-check-yy 直接消费这个 API) |
| `docs/RULE-CHECK-DEV-GUIDE-yy.md` | 开发交接文档,代码层视角(本仓库内 rule-check-yy 模块的实现细节) |
| `docs/MERGE-INTO-STEVEN-MANIFEST-yy.md` | 本文,集成清单 |

---

## 3. 在 steven 既有文件上的可加性变更

以下 steven 既有文件被 merge 修改,均为**纯追加 / 命名空间隔离**,没有覆写 steven 既有内容。

### 3.1 `lib/i18n.tsx`

新增 i18n key:

- `nav_rule_check_yy`(zh / en)+ `nav_group_trust_yy`(zh / en)— LeftNav 显示名
- 170 个 `rc_yy_*` key(zh / en 各一份)— 覆盖 dashboard / runs / rules / candidates / audit / settings / Matrix / Aggregate / Inference / Counterfactuals / Replay 所有 UI 字符串

不动 steven 既有的 `nav_rule_check` / `nav_group_trust` 与其它 nav / wf / em / agent / evt key。

### 3.2 `components/shared/LeftNav.tsx`

新增一条 nav item:

```ts
{ type: "group", title: t("nav_group_trust_yy") },
{ type: "item", id: "rule-check-yy", icon: "shield",
  label: t("nav_rule_check_yy"), href: "/rule-check-yy" },
```

不动 steven 既有的 `rule-check` nav item。Merge 后侧边栏会有**两条 rule-check 入口**:steven 版指向 `/rule-check`,yy 版指向 `/rule-check-yy`,各自打开各自的 dashboard。

### 3.3 `.gitignore`

新增 3 行:

```
data/simple-rule-check-yy-runs/
data/rule-check-yy-runs/
data/dev/
```

### 3.4 `package.json`

**新增 6 个 npm script**:`simple-rule-check-yy` / `:seed` / `:seed:check`,`rule-check-yy` / `:seed` / `:seed:check`,以及 `dev:dump-match-resume-prompt`(开发用 prompt dump)。

**新增依赖**:`@types/uuid` ^10、`uuid` ^14、`zod` ^4、`openai` ^6.37(在 union 中,steven 之前是 6.34,合并取高位)。

**`dev` 脚本**:steven 既有的 `node scripts/dev-bootstrap.mjs && next dev -p 3002` 胜出。yy 的旧 `next dev -p 3002` 已被 steven 的 `dev:next-only` 等价覆盖,无功能丢失。

### 3.5 `.env.example`

新增两行(rule-check-yy 用):

```
OPENAI_MODEL=gpt-4o
# OPENAI_TIMEOUT_MS=600000   (default 10 min; covers Path C per-step calls)
```

`DATABASE_URL` 取 steven 版(SQLite),yy 的 postgres 版本以注释保留。

---

## 4. 完全未触碰的 steven 文件

以下都**零改动**:

- `app/rule-check/*`(steven 的所有 page / actions)
- `app/api/rule-check*/*`(全部 5 个 API route + 5 个 `rule-check-audits` route)
- `lib/rule-check/*`(steven 的 17 个 TS 文件,含 `runner.ts`、`evidence/rule-10-*`、`graph-context.ts`、`instance-client.ts`、`llm.ts`、`log.ts`、`neo4j-instance-writer.ts`、`neo4j-match-result-writer.ts`、`ontology.ts`、`prisma-audit-writer.ts`、`prompt.ts`、`resume-projection.ts`、`rules.json`、`runner.ts`、`types.ts`、`yeyang-runner.ts`)
- `components/rule-check/*`(steven 的 17 个 .tsx 含 `ScenarioMatrix` / `GraphView` / `MetricsStrip` / `CaseDrawer` / `RuleCheckContent` / `TopBar` / `RuleConfusionStrip` / `RuleCheckAuditsContent` / `RuleSeverityMatrix` / `bucketing` / `neo4j-jump` / `use-run-stream`)
- `prisma/`、`__tests__/`、`server/`、`resume-parser-agent/`、`docker-compose.inngest.yml`、`prisma.config.ts`、`vitest.config.ts`
- steven 既有的所有 npm scripts(`inngest:*` / `db:*` / `test` / `register` / `publish:test` / `minio:*` 等)
- steven 既有的所有 env vars(`AGENT_API_KEY` / `EM_BASE_URL` / `INNGEST_*` / `RAAS_API_BASE_URL` / `RULE_CHECK_ENABLED` / `RULE_CHECK_AUGMENT_RESUME` / `RULE_CHECK_PARTIAL_RESUME` / `WS_BASE_URL`)

---

## 5. 共享 ontology-gen 演化的非破坏更新

以下 `lib/ontology-gen/` 和 `generated/v4/` 文件被自动更新到 yy 演化后的最新版本。**Steven 在 merge-base(`d3d78de`)之后未修改过这些文件**,所以这是单向前进,**无内容丢失**:

| 文件 | 变化 |
|---|---|
| `generated/v4/action-object-v4.types.ts` | 加 `RuntimeScope` / 重整 `MatchResumeRuntimeInput` |
| `generated/v4/match-resume.action-object.ts` | 重生成的 snapshot |
| `lib/ontology-gen/client.ts` | 加 `postJson`(用于 seed 脚本写测试数据);加 409 / `schema-not-found` / `instance-not-found` 错误类型 |
| `lib/ontology-gen/v4/assemble.ts` | v4-1/2/3 alternative assembler 演进 |
| `lib/ontology-gen/v4/assemble-v4-4.ts` | 加 `## 当前时间` 注入 / `## 额外数据` rendering / `focusStep` Path C 模式 |
| `lib/ontology-gen/v4/fill-runtime-input.ts` | **API breaking change**: `fillRuntimeInput(obj, input, scope)` — 第 3 arg `scope: RuntimeScope` 改为 required。详见 §7 caveat |
| `lib/ontology-gen/v4/generate-prompt.ts` | 加 `extraInstances` / `focusStep` / `timeoutMs` 选项;`compiledAt` 行为修订 |
| `lib/ontology-gen/v4/index.ts` | 公开 ABI 调整:从 `runtime-adapters/*` re-export `RuntimeScope` / `RuntimeInputV4` / `matchResumeAdapter` / `findAdapterByAction` / `registerAdapter` 等 |
| `lib/ontology-gen/v4/placeholders.ts` | 改为 shim,重定向到 `runtime-adapters/match-resume` |
| `lib/ontology-gen/v4/runtime-input.types.ts` | 同上 shim |

---

## 6. 新增的 ontology-gen 文件

7 个全新文件,自然加入,无路径冲突:

- `lib/ontology-gen/v4/envelope-schema.ts` — SSOT:`MatchResumeEvalEnvelopeZod` + `MatchResumeEvalEnvelopeJsonSchema` + `StepResultZod` + `StepResultJsonSchema`
- `lib/ontology-gen/v4/runtime-adapters/index.ts` — adapter barrel + `registerAdapter(matchResumeAdapter)` 顶层副作用
- `lib/ontology-gen/v4/runtime-adapters/match-resume.ts` — matchResume 的类型 / 占位符 / sentinel / adapter
- `lib/ontology-gen/v4/runtime-adapters/registry.ts` — adapter 注册表与查询(`findAdapterByAction` / `listAdapters`)
- `lib/ontology-gen/v4/runtime-adapters/substitute.ts` — single-scan 占位符正则替换
- `lib/ontology-gen/v4/runtime-adapters/types.ts` — `ActionRuntimeAdapter<T>` / `RuntimeInputV4` / `RuntimeScope`
- `lib/ontology-gen/v4/runtime-adapters/utils.ts` — `renderJsonBlock` + `formatBeijingTimeISO`

---

## 7. 已知 caveat — `lib/rule-check/yeyang-runner.ts`(steven 既有)

Steven 既有文件 `lib/rule-check/yeyang-runner.ts` 调用 `fillRuntimeInput(matchResumeActionObject, runtimeInput)`,**仅 2 个 arg**。yy 演化后的 `fillRuntimeInput(obj, input, scope)` 要求 3 个 arg,第 3 个 `scope: RuntimeScope` 在 `matchResumeAdapter.buildSubstitutions(input, scope)` 内被 dereference 为 `scope.client` / `scope.department`。

**影响**:
- TS 编译:`yeyang-runner.ts` 头部已经有 `@ts-nocheck`,所以**不报错**。
- 运行时:启用 `RULE_CHECK_PROMPT_SOURCE=yeyang` 调到这条路径时,会抛 `Cannot read properties of undefined (reading 'client')`。

**本次集成不修**。文件本身的 header 已自标注 "WIP, depends on legacy LlmRuleCheckOutput / RuleCheckVerdict / RuleFlag types not exported in the post-merge types.ts" —— steven 团队预期这条路径要在下一轮整合时重构。

**临时绕开**(若想立刻用):在 yeyang-runner 调用处加默认 scope:

```ts
const filled = fillRuntimeInput(matchResumeActionObject, runtimeInput,
  { client: input.job_requisition.client_id ?? "", department: "" });
```

---

## 8. 如何运行 yy 这套

### 8.1 一次性准备(seed 测试数据)

```bash
# .env.local 需要:
#   ONTOLOGY_API_BASE=http://localhost:3500
#   ONTOLOGY_API_TOKEN=<bearer>
#   OPENAI_API_KEY=<key>
#   OPENAI_MODEL=gpt-4o   (or compatible)

npm run rule-check-yy:seed:check   # schema 验证 only
npm run rule-check-yy:seed         # 种数据(idempotent)
```

### 8.2 CLI 跑 batch

```bash
# Full impl
npm run rule-check-yy -- \
  --candidate C-MVP-001 \
  --client 腾讯 \
  --job JR-MVP-TENCENT-001 \
  --output pretty

# MVP 单 rule
npm run simple-rule-check-yy -- \
  --rule 10-7 \
  --candidate C-MVP-001 \
  --client 腾讯 \
  --job JR-MVP-TENCENT-001
```

### 8.3 浏览器看 Prove UI

```bash
npm run dev   # 进 http://localhost:3002
```

- 侧边栏 Trust group → "Rule Check" 是 yy 版,挂在 `/rule-check-yy`(steven 既有的入口仍挂在 `/rule-check`)
- `/rule-check-yy` aggregate dashboard
- 点 batch → `/rule-check-yy/batches/<batchId>`
- 点 cell → `/rule-check-yy/runs/<runId>` 看 8-layer Prove 详情
- `/rule-check-yy/matrix` 看 candidates × rules
- `/dev/rule-check-yy` 表单触发新 batch

### 8.4 详细文档

- 上游 prompt 系统:[GENERATE-PROMPT-USER-GUIDE-yy.md](GENERATE-PROMPT-USER-GUIDE-yy.md)
- 代码架构 / 数据流:[RULE-CHECK-DEV-GUIDE-yy.md](RULE-CHECK-DEV-GUIDE-yy.md)
- 设计决策日志:[RUNTIME-RULE-CHECKER-SPEC-yy.md](RUNTIME-RULE-CHECKER-SPEC-yy.md)

---

## 9. 如何拆掉 yy 这套(future 融合阶段)

当 steven 团队决定 yy 这套不再需要(或合并 / 取代了),完整删除步骤如下:

```bash
# 1. 删代码
rm -rf app/rule-check-yy app/dev/rule-check-yy app/dev/simple-rule-check-yy
rm -rf lib/rule-check-yy lib/simple-rule-check-yy
rm -rf components/rule-check-yy
rm scripts/rule-check-yy.ts scripts/simple-rule-check-yy.ts scripts/simple-rule-check-yy-seed.ts

# 2. 删文档
rm docs/RUNTIME-RULE-CHECKER-SPEC-yy.md
rm docs/GENERATE-PROMPT-USER-GUIDE-yy.md
rm docs/RULE-CHECK-DEV-GUIDE-yy.md
rm docs/MERGE-INTO-STEVEN-MANIFEST-yy.md   # 这个文件本身

# 3. 删运行时数据
rm -rf data/rule-check-yy-runs data/simple-rule-check-yy-runs
```

然后手工清理:

- `lib/i18n.tsx` — 删 4 个 `nav_*_yy` key + 170 个 `rc_yy_*` key(zh + en)
- `components/shared/LeftNav.tsx` — 删 yy 的 nav item 与 group
- `package.json` — 删 6 个 `*-yy` script + 3 个 dep(`@types/uuid` / `uuid` / `zod`,如果 steven 别处没用);`openai` 版本回到 steven 原版
- `.gitignore` — 删 3 行 `data/*-yy-runs/` 与 `data/dev/`
- `.env.example` — 删 `OPENAI_MODEL` / `OPENAI_TIMEOUT_MS`(如果 steven 别处没用)

`lib/ontology-gen/v4/*` 与 `generated/v4/*` 的 yy 演化版本**不要删** —— `lib/rule-check/yeyang-runner.ts`(steven 既有)和 `app/dev/generate-prompt/*`(steven 既有)都依赖。
