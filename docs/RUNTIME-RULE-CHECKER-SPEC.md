# Runtime Rule Checker — Design SPEC

**Status**: MVP shipped as `simple-rule-check`; full `rule-check` impl pending
**Date**: 2026-05-12
**Scope**: matchResume rule evaluation (architecturally extensible to other actions)
**Related docs**: `docs/GENERATE-PROMPT-USER-GUIDE.md`, `ONTOLOGY-API-USER-GUIDE-BASED-ON-NEO4J.md`

## Module naming (locked)

| Phase | Module path | npm scripts | Dev UI | Status |
|---|---|---|---|---|
| **MVP (current)** | `lib/simple-rule-check/` | `simple-rule-check`, `simple-rule-check:seed`, `simple-rule-check:seed:check` | `/dev/simple-rule-check` | **Shipped, frozen** |
| **Full impl** | `lib/rule-check/` (active) | `rule-check`, `rule-check:seed*` | `/rule-check/*` | **Shipped — Path C runtime** |

The MVP is intentionally preserved as a separate module. Full impl is a **new module**, not a rewrite of the MVP — the MVP stays as the simple baseline so we can A/B against the full implementation.

### Critical coupling: `rule-check` consumes `generatePrompt` (locked)

For the full `rule-check` impl, the prompt fed to the LLM **must be derived verbatim from `generatePrompt`'s output** — not constructed by `rule-check` from scratch (as the MVP does via `extractor.ts`). **No section discarding, no post-processing strip.** This makes the two modules a single auditable chain:

```
generatePrompt(actionRef, client, dept?)  →  ActionObjectV4 (rules + schema + exec constraints)
                                              ↓ consumed verbatim by
                              ┌───────────────┴──────────────────┐
                              ▼                                  ▼
                       rule-check (eval)                 matchResume executor agent
                       (Trust UI / audit)                (Inngest worker / production)
                              │                                  │
                              └──────── share same ──────────────┘
                                       output schema
```

#### The single-contract principle (locked 2026-05-12)

`generatePrompt`'s **prompt and output schema together form a single contract** shared by both downstream consumers:

1. **`rule-check`** — evaluates against real Neo4j data, validates, attaches audit metadata, persists for Prove UI
2. **`matchResume` executor agent** — same prompt + same output schema, but proceeds to downstream routing (Neo4j writes, notifications, terminal short-circuit)

To make this single contract work, **`generatePrompt`'s output template is being rewritten** so its `## 最终输出 JSON 结构` produces an **execution-shaped envelope** whose `step_results.*.rule_judgments[]` are structurally identical to `rule-check`'s `RuleJudgmentAudited`. Both consumers parse the same envelope; their downstream differs but the LLM contract does not.

Rationale: `generatePrompt` is the **canonical source of truth** for "what the LLM sees and produces". If `rule-check` built its own prompt or imposed its own output schema, the two systems would silently drift — a rule change shipped through `generatePrompt` wouldn't reach `rule-check`'s evaluation until someone manually synced. By forcing both consumers onto generatePrompt's contract verbatim, we get:

1. **No double bookkeeping** of rule text / output schema / execution constraints.
2. **Single auditability surface** — the same prompt the operator sees in `/dev/generate-prompt` is the prompt the Checker fed to the LLM (modulo the runtime input substitution layer).
3. **Free downstream rule updates** — any change in the ontology repo flows through `generatePrompt` into `rule-check` without a code change.
4. **No section-discarding hack** — `rule-check` never strips parts of generatePrompt's output; if a part doesn't fit the eval contract, the right fix is to **modify `generatePrompt`'s template**, not to post-process.

`simple-rule-check` (MVP) does **not** need this coupling — it stays on the extractor strategy as the simple baseline.

#### What it means to modify `generatePrompt`'s template

Concretely, `lib/ontology-gen/v4/assemble-v4-4.ts` will be updated so:

- `renderFinalOutputSchema(action)` produces the new execution-shaped envelope (see §6.3) with embedded `rule_judgments[]` per step.
- `renderConstraints()` teaches the LLM the new contract (rule_judgments, evidence-grounding requirement, decision enum) instead of the old `fired_rule_ids` / `blocking_rule_ids` semantics.
- `renderBeforeReturn()` and `renderFinalConsolidation()` are updated to match.
- `step4` (scoring step, when present) **temporarily omits the `score` field** from its rule_judgments output — to be re-introduced once scoring spec is finalized.

The matchResume executor agent (external Inngest worker, not in this repo) must adopt the new envelope shape; this coordination is out-of-scope for this SPEC but is a hard dependency for putting the Full impl into production.

---

## 1. Context

`generatePrompt` produces a static prompt artifact for matchResume — rules + schema + execution constraints — but does not execute anything. It does not fetch runtime data, does not call an LLM, and does not produce decisions.

Kenny's question — **"how do you prove the result is correct?"** — demands more:

1. Real runtime data fetched from Neo4j as the **single source of truth** (not synthesized in the prompt)
2. LLM-driven rule evaluation **against that real data**
3. **Deterministic verification** that the LLM's output is grounded (no hallucinated evidence, no fabricated rule IDs)
4. Persistent **audit trail** enabling post-hoc Q&A
5. Demonstrable handling of both **positive** (should block → blocks) and **negative** (shouldn't block → doesn't) cases

This SPEC defines a new **Runtime Rule Checker** module that addresses these gaps. It sits downstream of `generatePrompt` in the matchResume business flow:

- Consumes rule definitions + scope
- Fetches required runtime evidence from the Ontology API
- Calls LLM to produce per-rule judgments
- Runs deterministic post-validation to catch LLM hallucination
- Persists a complete audit record
- Returns a structured decision the matchResume agent can route on

### The Ontology API is the inferencing capability source

Critically, the Ontology API (`/api/v1/ontology/*`, port 3500, Neo4j-backed) is not merely a database — it's the **inferencing substrate** the Checker is built on. Every dimension of rule evaluation pulls from a distinct API capability:

| Checker need | Ontology API capability |
|---|---|
| Fetch action's rules (with client-scoped filtering) | `GET /api/v1/ontology/actions/{ref}/rules?domain=...` |
| Read schema for instance / evidence validation | `GET /api/v1/ontology/schema/objects?domain=...` |
| Fetch single instance (Candidate, Job_Requisition) | `GET /api/v1/ontology/instances/{label}/{pk}?domain=...` |
| List instances with filter (Application, Blacklist) | `GET /api/v1/ontology/instances/{label}?domain=...&<filter>` |
| Seed test data | `POST /api/v1/ontology/instances/{label}` (bulk upsert supported, **seed script only** — not the Checker itself) |
| Future: rule classification metadata | extension to Rule node properties (v1.1) — **read-only**, owned by the ontology repo |

The Checker is therefore **deeply coupled to the Ontology API**, but the coupling is via stable HTTP contracts (per [ONTOLOGY-API-USER-GUIDE-BASED-ON-NEO4J.md](../ONTOLOGY-API-USER-GUIDE-BASED-ON-NEO4J.md)). All HTTP traffic goes through `lib/ontology-gen/client.ts` (already shipped). The Checker never talks bolt:// Neo4j directly.

### Test data must be initialized before MVP can run

The graph database does **not** currently contain the candidates, jobs, application history, or blacklist records the MVP demos against. A one-time **seed script** (`scripts/simple-rule-check-seed.ts`) initializes `RAAS-v1` domain via the Ontology API. The seed is idempotent (upsert-by-PK), and verification probes confirm presence before any rule check runs. The domain isolation (`RAAS-v1` vs production `RAAS-v1`) is essential — seed never touches prod.

**MVP** focuses on a tight closed loop — 5 rules spanning all instance-fetch shapes (single-field, nested, cross-object via Application) — with both positive and negative test cases — to prove correctness end-to-end. **Full implementation** scales to all matchResume rules, adds batch + composite confidence, and ships a commercial-grade product UI.

---

## 2. Goals + Non-goals

### Goals

| | |
|---|---|
| **Auditable** | Every check produces a complete trace: input + fetched evidence + prompt + LLM response + validation + final decision |
| **Hallucination-resistant** | Step-9 deterministic validation catches non-existent rule IDs, ungrounded evidence, schema violations |
| **Decoupled from generatePrompt's text format** | Checker pulls rules from the Ontology API directly via `fetchAction`; does NOT parse generatePrompt's prompt string |
| **Scales without refactor** | MVP single-rule architecture extends to batch evaluation via reserved interface; storage / confidence / prompt-strategy are pluggable from day one |
| **Reusable for Q&A** | Saved runs support post-hoc "why was C002 blocked" queries (full impl) |
| **Demonstrable** | CLI for engineers + dev UI for MVP; full-impl ships a polished product UI |

### Non-goals

- **Never** writing new DataObject instances into the Ontology API (incl. `RuleCheckResult` or any other write-back). The Checker is a **read-only consumer** of the Ontology API. Audit lives on filesystem (MVP) and on filesystem + an out-of-band store TBD (full impl) — **never** as Neo4j nodes. Locked decision; not negotiable.
- Full matchResume agent orchestration — described in flow only; not built in this SPEC
- Multi-action support — matchResume only for MVP, but contract leaves room
- Persisted rule classification — hand-coded switch in MVP; metadata-driven in v1.1
- Production-grade reliability — no circuit breakers, rate limiters, retry policies (only 1 retry for LLM transient errors)
- Cost optimization — no LLM response caching in MVP

---

## 3. MVP vs Full implementation — at a glance

| Dimension | **MVP** | **Full implementation** |
|---|---|---|
| Rules covered | **5 rules**: 10-7 (期望薪资), 10-17 / 10-18 / 10-25 (blacklist class — candidate-internal), **10-32 (岗位冷冻期 — cross-object Application)** | All matchResume rules (40+), extensible to other actions |
| Instance fetch shapes exercised | Candidate single-field, Candidate nested (work_experience), **Application list-with-filter** | + Blacklist, Locks, cross-action results |
| Prompt strategy | **B**: extract single rule's text + execution-constraint wrapper | **A**: verbatim consumption of `generatePrompt`'s output (no section discard); `generatePrompt` template is rewritten so output schema embeds `rule_judgments[]` per step (shared with matchResume executor) |
| LLM call pattern | **One call per rule** | **Path C (active runtime, locked 2026-05-13)**: per-step sequential LLM calls — one per `actionStep` with `rules.length > 0`. Each call returns `{ rule_judgments[] }` using `StepResultJsonSchema`. Orchestrator-controlled short-circuit on red-line `blocked` (when `canBlock !== false`). Path B (single-envelope `step_results.*.rule_judgments[]` + `final_output`) is the historical contract — its envelope (`MatchResumeEvalEnvelopeZod` / `renderEnvelopeSkeleton`) is retained for `/dev/generate-prompt` review only and not used at runtime. Path A (per-rule parallel) is a documented but unused alternative in §14.1. |
| Confidence | LLM self-reported `∈ [0, 1]` | Composite: `0.4 × logprob_score + 0.3 × evidence_count_factor + 0.3 × consistency_factor` |
| Storage | Filesystem `data/simple-rule-check-runs/<runId>.json` | Filesystem `data/rule-check-runs/<runId>.json` (Neo4j write-back is **forbidden** per §2 Non-goals; any future external store, e.g. OpenSearch or S3, is out-of-Ontology-API) |
| Public API | `checkRule()` only; `checkRules()` reserved (throws `Error("checkRules() is reserved for the full implementation")`) | `checkRule()` + `checkRules()` (batch via Path C per-step orchestration) |
| Validation | rule_id exists + evidence grounded + schema valid | + block-semantic check via rule classification metadata |
| Audit Q&A | Inspect trace JSON manually | LLM-driven Q&A panel + cross-run analytics |
| UI | `/dev/simple-rule-check` dev tool | `/rule-check/*` commercial product UI on port 3002 |

### Why this MVP is not throwaway

MVP code is structured behind interfaces so migration to full is **swap-implementation, not rewrite**:

| Interface | MVP impl | Full impl |
|---|---|---|
| `PromptStrategy` | `extractedRulePrompt` | `fullActionPrompt` |
| `Orchestrator` | `SingleCallOrchestrator` | `AllInOneOrchestrator` |
| `ConfidenceCalculator` | `LLMSelfReported` | `Composite` |
| `RunStore` | `FilesystemRunStore` | `FilesystemRunStore` (+ optional out-of-Ontology external store, e.g. object storage) — **never** a Neo4jRunStore |

The MVP **picks the simpler concrete for each**, but the abstraction is in place.

---

## 4. End-to-end business flow

Below is the **production target** flow. **MVP scope** is the highlighted block (steps 6-9 plus persistence); upstream agents (1-5) and downstream routing (10) are described for context.

```
┌───────────────────────────────────────────────────────────────┐
│ 1. Resume upload / download                                    │
└──────────────────────────────┬─────────────────────────────────┘
                               ▼
┌───────────────────────────────────────────────────────────────┐
│ 2. parseResume agent — parses resume document                  │
└──────────────────────────────┬─────────────────────────────────┘
                               ▼
┌───────────────────────────────────────────────────────────────┐
│ 3. resume-process event — triggers matchResume agent           │
└──────────────────────────────┬─────────────────────────────────┘
                               ▼
┌───────────────────────────────────────────────────────────────┐
│ 4. matchResume agent — resolves (candidate, job, client,       │
│    department) from event payload                              │
└──────────────────────────────┬─────────────────────────────────┘
                               ▼
┌───────────────────────────────────────────────────────────────┐
│ 5. matchResume agent calls `generatePrompt({ actionRef:        │
│    "matchResume", client, clientDepartment? })`                │
│    → ActionObjectV4 with rule defs, schema, execution rules    │
└──────────────────────────────┬─────────────────────────────────┘
                               ▼
╔═══════════════════════════════════════════════════════════════╗  ◄═══ MVP
║ 6. matchResume agent calls Runtime Rule Checker               ║   scope
║                                                               ║   begins
║ ┌───────────────────────────────────────────────────────────┐ ║
║ │ 7. Checker fetches required instances from Ontology API   │ ║
║ │    (Neo4j-backed):                                        │ ║
║ │      - Candidate by candidateId                           │ ║
║ │      - Job_Requisition by jobRef (if rule needs it)       │ ║
║ │      - Application filtered by (candidate, client) │ ║
║ │      - Blacklist filtered by (candidate, client)    │ ║
║ │    Selection driven by `instancesNeededForRule(ruleId)`   │ ║
║ │    — hardcoded switch in MVP, metadata-driven in v1.1     │ ║
║ └─────────────────────────┬─────────────────────────────────┘ ║
║                           ▼                                   ║
║ ┌───────────────────────────────────────────────────────────┐ ║
║ │ 8. Checker builds eval prompt + calls LLM (single call):  │ ║
║ │      MVP:  extracted rule text + evidence + output schema │ ║
║ │            → single RuleJudgment                          │ ║
║ │      Full: verbatim generatePrompt output (no section     │ ║
║ │            discard) + FOCUSING_SYSTEM_MESSAGE             │ ║
║ │            → execution envelope per §6.3:                 │ ║
║ │            { step_results.*.rule_judgments[], final_output }│ ║
║ └─────────────────────────┬─────────────────────────────────┘ ║
║                           ▼                                   ║
║ ┌───────────────────────────────────────────────────────────┐ ║
║ │ 9. Checker validates LLM output (deterministic):          │ ║
║ │    a. rule_id ∈ fetched rules                             │ ║
║ │    b. each evidence references (objectType, objectId)     │ ║
║ │       in fetched.instances; field exists; value matches   │ ║
║ │    c. response parses against Zod schema                  │ ║
║ │    d. block-semantic check (skipped in MVP)               │ ║
║ │                                                           │ ║
║ │    On failure: do NOT retry. Record failure tags; force   │ ║
║ │    finalDecision.decision = "pending_human" with overrideReason │ ║
║ └─────────────────────────┬─────────────────────────────────┘ ║
║                           ▼                                   ║
║                Persist RuleCheckRun                           ║
║                  → data/simple-rule-check-runs/<YYYYMMDD>/<runId> ║
║                                                               ║
║                Return RuleCheckRun                            ║
╚═══════════════════════════════════════════════════════════════╝  ◄═══ MVP
                               │                                     scope
                               ▼                                     ends
┌───────────────────────────────────────────────────────────────┐
│ 10. matchResume agent routes on finalDecision.decision:        │
│       - blocked         → stop recommendation                  │
│       - pending_human   → suspend for human review             │
│       - passed          → continue to scoring                  │
│       - not_started     → rule didn't apply; continue, no flag │
└───────────────────────────────────────────────────────────────┘
```

**MVP invocation surfaces** (replacing step 6 in the agent flow):

- CLI: `npm run simple-rule-check -- --rule 10-7 --candidate C-MVP-001 --job JR-MVP-001 --client 腾讯 --domain RAAS-v1`
- Web UI: `/dev/simple-rule-check` form

---

## 5. System architecture

### 5.1 Module map

```
lib/
├── ontology-gen/                     (existing — unchanged)
│   ├── fetch.ts                       (reused: fetchAction)
│   ├── v4/                            (reused: generatePrompt, adapters)
│   └── ...
├── simple-rule-check/                ◄── MVP MODULE (shipped, frozen)
│   ├── types.ts                       # CheckRuleInput, RuleJudgment, Evidence, ValidationReport, RuleCheckRun
│   ├── fetch-instances.ts             # GET /api/v1/ontology/instances/{label}/{pk|filter}
│   ├── rule-instance-map.ts           # switch(ruleId) → InstanceSpec; hardcoded
│   ├── prompt/
│   │   ├── extractor.ts               # extract single rule text + wrapper
│   │   ├── full.ts                    # stub: throws NotImplementedError
│   │   └── index.ts                   # PromptStrategy interface
│   ├── llm-client.ts                  # OpenAI Chat Completions wrapper (response_format json_schema)
│   ├── output-schema.ts               # Zod schema for RuleJudgment
│   ├── confidence/
│   │   ├── self-reported.ts
│   │   └── index.ts                   # ConfidenceCalculator interface
│   ├── validation/
│   │   ├── rule-id.ts
│   │   ├── evidence-grounded.ts
│   │   ├── schema.ts
│   │   ├── block-semantic.ts          # returns "skipped"
│   │   └── index.ts                   # runValidation()
│   ├── store/
│   │   ├── filesystem.ts              # the only store (no Neo4j write-back ever)
│   │   └── index.ts                   # RunStore interface
│   ├── orchestrator/
│   │   ├── single-call.ts             # one LLM call, one rule
│   │   └── index.ts                   # Orchestrator interface
│   ├── checker.ts                     # Public: checkRule(); checkRules() throws NotImplementedError
│   └── index.ts                       # Barrel exports
└── rule-check/                       ◄── FULL impl module (Path C runtime, active)
    ├── index.ts                       # ABI: { checkRule, checkRules } + audited types
    ├── checker.ts                     # checkRules() → allInOneOrchestrator.run(); checkRule() = filter sugar
    ├── types.ts                       # re-export MVP base types + FetchedRuleClassified
    ├── types-audited.ts               # RuleJudgmentAudited / RuleCheckRunAudited /
    │                                  # RuleCheckBatchRunAudited / StepCallRecord / etc.
    ├── output-schema-audited.ts       # Zod + JSON Schema (re-export from v4/envelope-schema)
    ├── debug.ts                       # rcLog / rcInfo / rcDebug / rcWarn + RULE_CHECK_DEBUG
    ├── aggregate-decision.ts          # cascade aggregate: blocked > pending_human > passed > not_started
    ├── llm-client.ts                  # OpenAI SDK + streaming + strict json_schema + logprobs env
    ├── fetch-rules.ts                 # wrap fetchAction + applyClientFilter; derive canBlock / requiredInstances
    ├── fetch-instances.ts             # Ontology GET single/list via tracedGetJson
    ├── fetch-extra-instances.ts       # rule.spec-driven prefetch (Candidate / Application / Blacklist)
    ├── rule-instance-map.ts           # ruleId → InstanceSpec for 10-7 / 10-17 / 10-18 / 10-25 / 10-32
    ├── instance-overview.ts           # UI overview-card data shapers
    ├── server-actions.ts              # /rule-check/* server actions
    ├── orchestrator/
    │   ├── all-in-one.ts              # ★ Path C core: A-G stages, per-step LLM, short-circuit
    │   └── index.ts                   # Orchestrator interface + re-export allInOneOrchestrator
    ├── prompt/
    │   ├── build.ts                   # buildEvalPrompt: generatePrompt → fillRuntimeInput → SHA256 provenance
    │   ├── focusing-system.ts         # FOCUSING_SYSTEM_MESSAGE
    │   └── runtime-input-loader.ts    # loadMatchResumeRuntimeInput
    ├── validation/
    │   ├── index.ts                   # runValidationAudited orchestrator (4 checks)
    │   ├── schema.ts                  # Zod safeParse → issues
    │   ├── rule-id.ts                 # rule_id ∈ fetchedRules
    │   ├── evidence-grounded.ts       # JSONPath-lite + deepEqual; tags ev.grounded; lenient (Q4)
    │   └── block-semantic.ts          # canBlock=false ∧ decision=blocked → warning
    ├── confidence/
    │   ├── index.ts                   # ConfidenceCalculator interface + composite re-export
    │   └── composite.ts               # 0.4·logprob + 0.3·evidenceCount + 0.3·consistency
    └── store/
        ├── index.ts                   # RunStore interface + RunQuery / RunIndexEntry
        ├── filesystem.ts              # writeRun / writeBatch / listRuns / getRun / getBatch (JSONL index)
        ├── external.ts                # OpenSearch / ClickHouse stubs (throw NOT_IMPLEMENTED)
        └── ontology-trace-recorder.ts # tracedGetJson: wraps getJson, records every HTTP into traceCtx.trace[]

scripts/
├── simple-rule-check.ts              # MVP CLI → simple-rule-check.checkRule()
├── simple-rule-check-seed.ts         # MVP seed: 14 instances to RAAS-v1
├── rule-check.ts                     # Full impl CLI → checkRules()
└── rule-check-seed.ts                # alias for simple-rule-check-seed.ts (declared in package.json)

app/dev/simple-rule-check/             # MVP dev UI (URL-only, not in LeftNav)
├── page.tsx
└── actions.ts                         # Server action wrapper

app/dev/rule-check/                    # Full impl engineering preview
├── page.tsx
└── actions.ts                         # Calls runCheckBatch

app/rule-check/                        # Full product UI (Trust nav group)
├── page.tsx                           # / — aggregate (BatchList + BatchPreview)
├── actions.ts                         # thin "use server" re-export + LOCAL type redeclarations
├── matrix/page.tsx                    # /matrix — rules × candidates grid
├── rules/page.tsx                     # /rules — rule library
├── batches/[batchId]/page.tsx         # /batches/<id> — verdict + stepCalls + per-step rule cards
├── runs/[runId]/page.tsx              # /runs/<id> — 8-layer Prove detail page
├── runs/page.tsx                      # /runs — Next.js redirect("/rule-check") (307)
├── candidates/[id]/page.tsx           # /candidates/<id> — timeline (MOCK_RUNS demo)
├── audit/page.tsx                     # /audit — compliance export stub
└── settings/page.tsx                  # /settings — settings stub

data/simple-rule-check-runs/           # MVP audit traces (gitignored)
└── <YYYYMMDD>/<runId>.json

data/rule-check-runs/                  # Full impl audit traces (gitignored)
├── <YYYYMMDD>/<runId>.json            # per-rule run
├── batches/<batchId>.json             # per checkRules() invocation
└── index.jsonl                        # append-only listing index
```

### 5.2 Ontology API capabilities the Checker depends on

**The Checker (both simple-rule-check and the future rule-check) is strictly a *read* consumer of the Ontology API.** The only writes against the Ontology API are issued by the **seed scripts** (`scripts/simple-rule-check-seed.ts` etc.), which exist to bootstrap test data — they are not the Checker itself.

| Capability | Endpoint(s) | Used by | MVP / Full |
|---|---|---|---|
| Rule retrieval (action-scoped, client-filtered) | `GET /api/v1/ontology/actions/{ref}/rules?domain=...&client=...` | `lib/simple-rule-check/fetch-rules.ts` (delegates to `lib/ontology-gen/fetch.ts`) | Both |
| Schema introspection | `GET /api/v1/ontology/objects/{label}?domain=...` | seed script (verify DataObject schemas exist); future `validation/evidence-grounded.ts` (verify `field` exists in schema) | Both |
| Single instance read | `GET /api/v1/ontology/instances/{label}/{pk}?domain=...` | `lib/simple-rule-check/fetch-instances.ts` (Candidate, Job_Requisition, …) | Both |
| Filtered instance listing | `GET /api/v1/ontology/instances/{label}?domain=...&<key=value>` | `lib/simple-rule-check/fetch-instances.ts` (Application by candidate+job, Resume by candidate, Candidate_Expectation by candidate) | Both |
| ~~Instance create / upsert~~ | ~~`POST /api/v1/ontology/instances/{label}`~~ | **Seed scripts ONLY** (`simple-rule-check-seed.ts`); never invoked by the Checker at runtime | seed-time only |
| ~~Instance update~~ | ~~`PUT /api/v1/ontology/instances/{label}/{pk}`~~ | Seed scripts only | seed-time only |
| ~~Persist RuleCheckResult~~ | — | **REMOVED.** Per §2 Non-goals, the Checker never writes any DataObject (incl. RuleCheckResult) into the Ontology API. Audit lives on filesystem (and future out-of-Ontology external storage if needed). | **forbidden** |

**Domain policy**: the MVP seed and the Checker both default to `RAAS-v1`; the earlier RAAS-v1 isolation requirement has been dropped per user decision. Audit traces are local-only, so cross-environment risk is limited to whatever the configured `ONTOLOGY_API_BASE` points at.

### 5.3 Internal data flow (MVP single-call)

```
checkRule({ actionRef, ruleId, candidateId, jobRef?, scope, domain })
            │
            ▼
   ┌────────────────────────────┐
   │ fetchAction(actionRef,     │ ──► allRules[] (from Ontology API)
   │   domain, scope.client)    │
   └────────────┬───────────────┘
                ▼
   ┌────────────────────────────┐
   │ selectRule(allRules,       │ ──► rule { id, name, sourceText, stepId }
   │   ruleId)                  │
   └────────────┬───────────────┘
                ▼
   ┌────────────────────────────────────┐
   │ instancesNeededForRule(ruleId)     │ ──► spec: InstanceSpec
   │ (hardcoded switch — MVP)           │
   └────────────┬───────────────────────┘
                ▼
   ┌────────────────────────────────────┐
   │ fetchInstances(spec, ids, domain)  │ ──► fetched: FetchedInstances
   │ (Ontology API instance endpoints)  │
   └────────────┬───────────────────────┘
                ▼
   ┌────────────────────────────────────┐
   │ promptStrategy.build(rule,         │ ──► prompt: string
   │   fetched, scope, currentTime)     │
   │ (extractor in MVP)                 │
   └────────────┬───────────────────────┘
                ▼
   ┌────────────────────────────────────┐
   │ llm.chat.completions.create({      │ ──► raw: LLMRawResponse
   │   model, messages, response_format │
   │ })                                 │
   └────────────┬───────────────────────┘
                ▼
   ┌────────────────────────────────────┐
   │ runValidation(raw, rule, fetched,  │ ──► parsed: RuleJudgment | null
   │   allRules)                        │      validation: ValidationReport
   └────────────┬───────────────────────┘
                ▼
   ┌────────────────────────────────────┐
   │ computeFinalDecision(parsed,       │ ──► finalDecision
   │   validation)                      │
   └────────────┬───────────────────────┘
                ▼
   ┌────────────────────────────────────┐
   │ runStore.write(run: RuleCheckRun)  │
   └────────────┬───────────────────────┘
                ▼
            return run
```

---

## 6. Public API

### 6.1 MVP — `checkRule` (single rule, single call)

```ts
// lib/simple-rule-check/types.ts  (MVP)
// lib/rule-check/types.ts          (future full impl — same shape, different module)

export interface CheckRuleInput {
  /** Action selector (e.g. "matchResume"). */
  actionRef: string;
  /** Rule id (e.g. "10-7"). */
  ruleId: string;
  /** Candidate PK to evaluate. */
  candidateId: string;
  /** Optional job context. Some rules need this; the switch decides. */
  jobRef?: string;
  /** Tenant scope. `client` is required for rule filtering. */
  scope: { client: string; department?: string };
  /** Default "RAAS-v1" for MVP — isolation from production. */
  domain?: string;
  /** Env overrides. */
  apiBase?: string;
  apiToken?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  llmModel?: string;        // default "gpt-4o" (configurable)
}

export interface Evidence {
  sourceType: "neo4j_instance";  // FULL impl may add "external_api"
  objectType: string;            // e.g. "Candidate"
  objectId: string;              // e.g. "C-MVP-001"
  field: string;                 // e.g. "expected_salary"
  value: unknown;                // value LLM claimed it read
}

export interface RuleJudgment {
  ruleId: string;
  /** Locked four-value enum. See §7.6 for routing semantics. */
  decision: "not_started" | "passed" | "blocked" | "pending_human";
  evidence: Evidence[];
  /** Chinese, four-section self-justifying narrative — see §7.2. */
  rootCause: string;
  confidence: number;            // [0, 1]
  nextAction: string;
}

export interface ValidationReport {
  ruleIdExists: boolean;
  evidenceGrounded: boolean;
  schemaValid: boolean;
  blockSemanticCheck: "ok" | "warning" | "skipped";  // MVP always "skipped"
  overallOk: boolean;
  failures: string[];            // e.g. ["evidence_not_grounded", "field_mismatch:expected_salary"]
}

export interface RuleCheckRun {
  runId: string;                 // UUIDv7
  timestamp: string;             // ISO-8601
  input: CheckRuleInput;
  fetched: {
    rule: {
      id: string;
      name: string;
      sourceText: string;
      stepOrder: number;
      applicableScope: string;
    };
    instances: Array<{
      objectType: string;
      objectId: string;
      data: Record<string, unknown>;
    }>;
  };
  prompt: string;
  llmRaw: {
    model: string;
    response: unknown;            // raw API response, including logprobs if requested
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
  };
  llmParsed: RuleJudgment | null; // null if schema invalid
  validation: ValidationReport;
  finalDecision: {
    decision: "not_started" | "passed" | "blocked" | "pending_human";
    /** Populated when validation fails and LLM's decision is overridden to "pending_human". */
    overrideReason?: string;
  };
}

export async function checkRule(input: CheckRuleInput): Promise<RuleCheckRun>;
```

### 6.2 Full impl — `checkRules` (batch, reserved)

```ts
export interface CheckRulesInput extends Omit<CheckRuleInput, "ruleId"> {
  /** Specify rules. Default = all rules of the action. */
  ruleIds?: string[];
  /** Max concurrent LLM calls. Default 4. */
  concurrency?: number;
}

export interface RuleCheckBatchRun {
  batchId: string;
  timestamp: string;
  input: CheckRulesInput;
  results: RuleCheckRun[];        // one per rule
  aggregateDecision: {            // applies the matchResume aggregator
    decision: "not_started" | "passed" | "blocked" | "pending_human";
    triggeredRules: string[];
  };
}

export async function checkRules(input: CheckRulesInput): Promise<RuleCheckBatchRun>;
// MVP: throws NotImplementedError. Full impl wires AllInOneOrchestrator.
```

### 6.3 Full impl — audit-rich `RuleJudgment` schema (embedded in execution envelope)

> **v3 schema update (2026-05-13)**: `RootCauseSections` is now **3 fields** (`dataObservation` / `contrastReasoning` / `conclusion`); `ruleRequirement` was removed across template → Zod → JSON Schema → types → UI (see §15 row). Rule's original text is surfaced once on the batch detail page (`/rule-check/batches/[batchId]`) instead of being reproduced inside every judgment.
>
> **Q4 lenient (2026-05-13)**: `validation.overallOk` no longer ANDs `evidenceGrounded`; the check still runs and writes per-evidence `grounded` flags for audit but does NOT auto-flip judgments to `pending_human` on evidence mismatch (see §15 row).
>
> **Runtime update — Path C locked 2026-05-13**: The "single LLM call per matchResume run" model below describes the historical Path B contract; the runtime now executes **per-step sequential LLM calls with orchestrator-controlled short-circuit**. Path C details:
>
> - Each `actionStep` with `rules.length > 0` produces ONE LLM call. The output is just `{ rule_judgments: [...] }` — schema sub-shape of `step_results.<step_N>` below (`StepResultJsonSchema` exported from `lib/rule-check/output-schema-audited.ts`).
> - Steps execute in `stepOrder` sequentially. After each step, the orchestrator checks for short-circuit: `∃ judgment.decision === "blocked" AND rule.canBlock !== false` (covers blocker rules + unclassified; advisory `canBlock=false` does NOT short-circuit). When triggered, subsequent steps are skipped — the orchestrator synthesizes `decision: "not_started"` audit records for their rules with `finalDecision.overrideReason: "short_circuit:step_<N>:rule_<id>"` (keeps matrix / aggregate complete).
> - `final_output` is NOT emitted by the LLM anymore. The orchestrator derives `aggregateDecision` (existing cascade) and adds `terminal: shortCircuitedAt !== null` + `terminalAtStep` deterministically. `notifications` and step-4 tool outputs (`match_results` / `overall_status`) are dropped in Path C v1; revisit when rule classifier provides notification metadata or a dedicated synthesizer is added.
> - LLM remains the sole judge of per-rule `decision`. Code-side responsibilities are limited to: (a) cascade aggregate, (b) flow-control short-circuit, (c) safety-net `pending_human` override on validation failure (`computeFinalDecision` — unchanged from MVP), (d) synthesized `not_started` markers for skipped steps' rules.
> - Audit shape: `RuleCheckBatchRunAudited.llmRaw / promptProvenance / aggregateDecisionLLMClaimed` are REPLACED with `stepCalls: StepCallRecord[]` (ordered array, includes skipped-step entries with `shortCircuited: true, llmRaw: null`). Each per-rule `RuleCheckRunAudited` keeps its step's `prompt / llmRaw / promptProvenance` denormalized for self-contained replay.
> - `MatchResumeEvalEnvelopeZod` + `matchResumeEvalEnvelopeJsonSchema` + `renderEnvelopeSkeleton` are RETAINED — they still serve `/dev/generate-prompt` full-prompt review. They are no longer the runtime decode contract.
>
> The historical Path B envelope shape is documented below for reference; the per-step `StepResult` shape is the active runtime contract.

The full impl extends the MVP `RuleJudgment` with **audit-trail fields** that the Prove-centric UI (§9.2) renders directly, **embedded inside the execution-shaped envelope produced by `generatePrompt`'s rewritten template**. The LLM produces one envelope per matchResume run (not a flat `judgments[]` array). The envelope is the single LLM-output contract shared by `rule-check` and the matchResume executor agent.

#### Envelope shape (LLM `response_format` strict schema)

```ts
// lib/rule-check/output-schema-audited.ts  (full impl)
// Mirrors the JSON Schema that generatePrompt's renderFinalOutputSchema() emits.

export interface MatchResumeEvalEnvelope {
  /** Per-step results. Step keys come from action.actionSteps ordered by step.order. */
  step_results: {
    [stepKey: string]: {
      /** Each step's rules each get one RuleJudgmentAudited. */
      rule_judgments: RuleJudgmentAudited[];
    };
  };

  /** Action-level aggregate. Derived by the LLM from step_results but
   *  re-checked deterministically by the orchestrator after parse. */
  final_output: {
    aggregateDecision: "passed" | "blocked" | "pending_human" | "not_started";
    /** Did any rule force terminal (blocked + can_block=true)? */
    terminal: boolean;
    /** Rule ids that contributed to the aggregate (typically blocked + pending_human). */
    triggeredRules: string[];
    /** Notifications emitted per rule (when sourceText requests notify/HITL). */
    notifications: Array<{
      recipient: string;
      channel: "InApp" | "Email";
      trigger_rule_id: string;
      reason: string;
    }>;
  };
}

/** Note on step4 (scoring): temporarily omits `score` field per locked decision
 *  2026-05-12. When scoring spec is finalized, score will be added back to the
 *  step4 rule_judgments[i] shape without breaking existing consumers. */
```

#### Per-judgment `RuleJudgmentAudited` shape

In code, `RuleJudgmentAudited` is a **standalone** interface (not a TS `extends RuleJudgment`) that restates the MVP base fields plus the audit-rich additions. See `lib/rule-check/types-audited.ts:55-67`.

```ts
export interface RuleJudgmentAudited {
  ruleId: string;
  decision: "passed" | "blocked" | "pending_human" | "not_started";
  nextAction: { type: "..."; ... };
  confidence: number;

  /** 3-section Chinese narrative. The UI parses it as structured. */
  rootCause: string;

  /** Parsed view of rootCause sections — the LLM emits this in parallel
   *  with the prose `rootCause` so the UI doesn't have to regex-split.
   *  (v3 schema update, 2026-05-13: dropped `ruleRequirement`. The rule's
   *  原文 lives once on `/rule-check/batches/[batchId]`, no longer repeated
   *  inside every judgment.) */
  rootCauseSections: {
    dataObservation: string;     // 【数据观察】
    contrastReasoning: string;   // 【对照推理】
    conclusion: string;          // 【结论】
  };

  /** NEW: per-evidence provenance. The LLM must populate these so each
   *  evidence row in the UI can deep-link back to the exact API call. */
  evidence: Array<Evidence & {
    /** Which fetched-instance entry this evidence cites. */
    fetchedInstanceIndex: number;
    /** Was the value byte-equal? (Filled by post-validation, not LLM.) */
    grounded: boolean;
    /** Was this evidence actually used to reach the verdict, or just informational? */
    decisive: boolean;
  }>;

  /** NEW: counterfactual sketches — the LLM proposes "what would flip this verdict".
   *  Powers the Ask-Why panel's pre-canned counterfactuals. */
  counterfactuals?: Array<{
    hypotheticalChange: string;  // "如果 expected_salary_range 改为 90000-100000"
    predictedDecision: "not_started" | "passed" | "blocked" | "pending_human";
    confidence: number;
  }>;
}

// In code, `RuleCheckRunAudited` is also a standalone interface (not extends
// Omit<RuleCheckRun,…>) restating all fields from `RuleCheckRun` plus the
// audited extensions. See `lib/rule-check/types-audited.ts:135-159`. The
// addition is `auditPath?: string` (path to the persisted JSON, set by
// orchestrator after filesystem write).

export interface RuleCheckRunAudited {
  runId: string;
  batchId?: string;
  timestamp: string;
  input: CheckRuleInput;
  fetched: { rule: { ...; stepOrder: number; ... }; instances: ... };
  prompt: string;
  llmRaw: { model: string; response: unknown; ... };
  llmParsed: RuleJudgmentAudited | null;
  validation: ValidationReport;
  finalDecision: FinalDecision;
  auditPath?: string;

  /** NEW: which prompt template + actionObject version produced this prompt.
   *  Lets the diff view in §9.2 detect drift since the run. */
  promptProvenance: {
    /** Hash of the full prompt string. Cheap drift detector. */
    promptSha256: string;
    /** Snapshot of generatePrompt's input args + the resulting ActionObjectV4
     *  hash. Allows reconstructing "what generatePrompt would emit now" for diff. */
    generatePromptInput: {
      actionRef: string;
      client: string;
      clientDepartment?: string;
      domain: string;
      runtimeInputDigest: string;
    };
    actionObjectSha256: string;
    /** The exact ISO-8601 timestamp the actionObject was resolved. */
    resolvedAt: string;
  };

  /** NEW: each Ontology API call the Checker made, with full HTTP exchange.
   *  Lets the UI's "Source" link in evidence cards show the actual request/response. */
  ontologyApiTrace: Array<{
    requestUrl: string;
    requestMethod: "GET";
    requestHeaders: Record<string, string>;
    responseStatus: number;
    responseBody: unknown;
    latencyMs: number;
    timestamp: string;
  }>;

  /** NEW: human-override audit log (populated when an operator overrides pending_human). */
  humanOverrides?: Array<{
    overrider: string;            // operator id / email
    overrideAt: string;           // ISO-8601
    fromDecision: "pending_human";
    toDecision: "passed" | "blocked";
    reason: string;               // free text, required
  }>;

  /** NEW: ask-why interactions appended over time. Each Q&A becomes part of audit. */
  askWhyHistory?: Array<{
    askedAt: string;
    asker: string;
    question: string;
    answer: string;
    /** Hash of the trace JSON state at the time of asking, for reproducibility. */
    traceSha256AtAsk: string;
  }>;
}
```

Why each new field exists:

| Field | Audit purpose |
|---|---|
| `rootCauseSections` | UI doesn't regex-split LLM prose; sections come pre-parsed by the LLM itself. Eliminates rendering ambiguity. |
| `evidence[*].grounded` | Lets validation results stay attached to each evidence row, not aggregated separately. |
| `evidence[*].decisive` | Distinguishes "evidence the verdict pivots on" from "evidence the LLM cited for context". Critical for the UI's "show only decisive evidence" toggle. |
| `counterfactuals` | LLM-proposed flip points. Powers the Prove UI's Ask-Why pre-canned questions and surfaces sensitivity (a verdict that flips on a 1% data change deserves a human look). |
| `promptProvenance` | Detects ontology drift since the run — if the actionObject hash changed but the verdict is being relied on, the UI flags it. |
| `ontologyApiTrace` | Every fetch call is part of the receipt. The UI's "Source" link goes directly to the HTTP exchange, not just a synthesized `(objectType, objectId)` claim. |
| `humanOverrides` | The manual-resolution audit log lives inside the run record itself, not in a separate system. |
| `askWhyHistory` | Conversational audit becomes part of the permanent trace; can never be silently discarded. |

This schema is what makes the UI of §9.2 actually possible. It's also what makes the audit story Kenny is asking for **falsifiable** — every claim has receipts attached at the schema level.

#### Why embed in execution envelope (locked 2026-05-12)

We chose to **embed** `rule_judgments[]` inside `step_results.*.<step>.rule_judgments[]` (Path B in the design exploration) instead of returning a flat `judgments[]` array (rejected) or running N parallel single-rule calls (Path A — reserved as backup, see §14):

| Reason | Detail |
|---|---|
| Single auditability contract | The matchResume executor agent's natural output shape IS step_results + final_output. By making `rule-check`'s LLM contract identical, the same prompt + same output works for both consumers — no schema fork. |
| Order preservation | `step_results.step_N` keys preserve `step.order` from the action definition; rule order within `rule_judgments[]` preserves `step.rules[].order`. Aggregation logic operates on this ordering without losing it. |
| Single call alignment | One matchResume "run" = one LLM call producing one envelope; matches the "execution" mental model the operator already has. |
| Aggregate decision built in | The LLM populates `final_output.aggregateDecision` based on its own judgments; the orchestrator re-derives it deterministically from `rule_judgments[]` as a cross-check (LLM-vs-deterministic agreement is itself an audit signal). |

### 6.4 Prompt-level skeleton vs API-level `response_format` schema

Two representations of the eval envelope's shape co-exist by design (locked 2026-05-13):

- **Prompt skeleton** — `## 最终输出 JSON 结构` section in the user message, rendered by `renderEnvelopeSkeleton(action)` in [lib/ontology-gen/v4/envelope-schema.ts](../lib/ontology-gen/v4/envelope-schema.ts). A textual JSON example using occurrence-type placeholders (`"<string>"`, `"passed|blocked|pending_human|not_started"`). Costs ~2K input tokens. Survives provider switching (any LLM that reads the prompt sees it). Aids human debugging when reading audit JSONs.
- **`response_format` strict schema** — `matchResumeEvalEnvelopeJsonSchema` in the same module; passed to OpenAI Chat Completions / kimi / equivalent as `response_format: { type: "json_schema", strict: true, schema: ... }`. API-level constraint applied during decoding (grammar-aware on supporting providers) and as a final rejection gate. Zero prompt-token cost. Requires provider support.

**These are belt-and-suspenders, not redundant claims.** Both representations live in the same module so they cannot drift accidentally — the file's docstring requires "if you edit one, edit both".

**Cross-check (2026-05-13)**: field-for-field comparison verified that every required field, enum value, type, and nesting level matches between the skeleton's occurrence-type placeholders and the strict schema's `type` / `enum` / `required` declarations. No conflicts.

**Skeleton removal (`P4`) decision — DEFERRED**: removing the skeleton would save ~2K input tokens but would NOT address the observed full-batch output-volume timeout (504s on matchResume's 12K-token-aggregate output). Cross-provider portability + audit-prompt readability outweigh the marginal input-cost saving. Re-evaluate only if a future provider switch makes schema-only desirable for a non-cost reason, or if an unrelated reduction in input size becomes critical.

**Path C addendum (2026-05-13)**: Per-step calls send `StepResultJsonSchema` (sub-shape of `step_results.<step_N>`'s value type, also exported from [envelope-schema.ts](../lib/ontology-gen/v4/envelope-schema.ts)) as the `response_format.json_schema.schema`, and embed a single-step skeleton `{ "rule_judgments": [...] }` rendered by `renderSingleStepEnvelopeSkeleton(step)` in the prompt's `## 最终输出 JSON 结构` section. Cross-check holds: every field in the per-step skeleton mirrors `StepResultJsonSchema` 1-to-1 (it's the exact `step_results.<step_N>` sub-shape). The full-envelope skeleton + schema are retained for `/dev/generate-prompt` and remain co-located in the same module — same sync policy applies.

---

## 7. Per-step design

### 7.1 Step 7 — Rule + instance resolution

`instancesNeededForRule(ruleId)` returns an `InstanceSpec`:

```ts
interface InstanceSpec {
  needsCandidate: boolean;       // always true in MVP
  needsJob?: boolean;
  needsApplications?: { byClient?: boolean; lookbackMonths?: number };
  needsBlacklist?: { byClient?: boolean; onlyActive?: boolean };
  needsLocks?: boolean;
}
```

#### MVP rule specs (hardcoded switch)

| Rule | Spec | Fetch shape exercised |
|---|---|---|
| `10-7` 期望薪资校验 | `{ needsCandidate: true }` | single-instance, single field |
| `10-17` 高风险回流人员 | `{ needsCandidate: true }` | single-instance, nested array (`work_experience`) |
| `10-18` EHS 回流人员 | `{ needsCandidate: true }` | single-instance, nested array |
| `10-25` 华为荣耀竞对 | `{ needsCandidate: true }` | single-instance, nested array + temporal (current time vs `end_date`) |
| **`10-32` 岗位冷冻期** | `{ needsCandidate: true, needsJob: true, needsApplications: { byClient: true, byJob: true, lookbackMonths: 3 } }` | **cross-instance list-with-filter + temporal** |

10-32 is the critical addition: it's the only rule of the five whose judgement is **literally impossible** without querying the graph for related instances. The candidate's `work_experience` doesn't tell us what jobs they previously applied to — that lives in `Application` (a separate DataObject linked by `candidate_id`). 10-32 forces the Checker to:
1. List `Application` records filtered by `(candidate_id, job_requisition_id, last 3 months)` via the Ontology API
2. Inspect each record's `status` for `筛选淘汰` / `面试淘汰` / `筛选通过未到面`
3. Feed all matching records into the LLM as evidence
4. Validate that LLM cites real `Application.<id>.status` values

If the LLM hallucinates an `Application` instance that wasn't fetched, the evidence-grounded validator catches it. That's the proof loop in microcosm.

Future v1.1: replace switch with metadata-driven (`rule_classification.json` or Ontology API rule-node extension).

#### Fetch implementation (`fetch-instances.ts`)

```ts
async function fetchCandidate(id: string, ctx: FetchCtx): Promise<Instance>;
async function fetchJob(ref: string, ctx: FetchCtx): Promise<Instance>;
async function listApplications(filter: { candidate_id, client?, since? }, ctx): Promise<Instance[]>;
async function listBlacklist(filter: { candidate_id, client?, active? }, ctx): Promise<Instance[]>;
```

All hit `GET /api/v1/ontology/instances/{label}/...?domain=...` per the Ontology API guide.

### 7.2 Step 8 — Eval prompt (MVP, extracted)

```
[system]
你是一名 Rule Evaluation Agent。你的任务是基于给定的 rule 原文和 candidate
的真实数据，判定该 candidate 在该客户的招聘场景下是否违反该 rule。

约束:
- 你只能使用 prompt 中提供的 rule 原文 + instance 数据
- 不允许编造 evidence — 每一条 evidence 必须能在提供的 instance 数据中
  精确定位到 (objectType, objectId, field, value)
- 如果数据不足以判定，输出 decision="pending" 并在 root_cause 中说明缺失字段
- 严格按指定 JSON schema 输出

[user]
## Action
{{actionRef}}

## 当前时间
{{currentTime}}    (ISO-8601, Asia/Shanghai)

## Client
{{scope.client}}{{?scope.department}} / {{scope.department}}{{/}}

## 待判定 Rule
[{{rule.id}}] {{rule.name}}
适用条件: {{rule.applicableScope}}
规则原文:
{{rule.sourceText}}

## Candidate (instance from Neo4j)
```json
{{candidate}}
```

{{?fetched.job}}
## Job (instance from Neo4j)
```json
{{job}}
```
{{/}}

## Output schema
按下面的 JSON schema 输出（response_format strict mode 强制）:
{{outputSchemaJson}}
```

### 7.2.full Step 8 — Eval prompt (Full impl: verbatim generatePrompt output)

The Full impl **does not build its own prompt template**. It consumes `generatePrompt`'s output as the user message, verbatim, and prepends a thin focusing system message.

```ts
// lib/rule-check/prompt/build.ts  (Full impl)

const templated = await generatePrompt({ actionRef, client, clientDepartment, domain });
//                  ↑ no runtimeInput — placeholders intact, used for provenance hashing
const resolved  = fillRuntimeInput(templated, runtimeInput, { client, department });
//                  ↑ substituted job/resume; this is what the LLM sees

return {
  system: FOCUSING_SYSTEM_MESSAGE,   // small, static contract reminder
  user:   resolved.prompt,            // verbatim generatePrompt output, no section discard
  provenance: {
    promptSha256:        sha256(stripCurrentTimeBlock(resolved.prompt)),
    actionObjectSha256:  sha256(stripCurrentTimeBlock(templated.prompt)),
    generatePromptInput: { actionRef, client, clientDepartment, domain,
                           runtimeInputDigest: sha256(stableStringify(runtimeInput)) },
    resolvedAt: new Date().toISOString(),
  },
};
```

#### What's in `resolved.prompt` (the verbatim user message)

All sections rendered by `assembleActionObjectV4_4`:

| Section | Content | Role for the eval LLM |
|---|---|---|
| `## 角色` | Action executor role | LLM treats this as the operating context |
| `## 重要约束` | 13 constraint bullets (updated to reference `rule_judgments` instead of `fired_rule_ids`) | Output contract reminder — aligned with §6.3 envelope |
| `## 任务` | Action description + execution intent | Context |
| `## 当前时间` | Beijing-time ISO-8601 | For time-dependent rules (10-17 / 10-25 etc.) |
| `## 运行时输入` | Substituted job + resume JSON | The data under evaluation |
| `## 最终输出 JSON 结构` | **Rewritten** — execution envelope per §6.3 (step_results.*.rule_judgments + final_output) | The strict output schema teaching |
| `## 执行步骤总览` | Step ordering preview | Tells LLM how step_results keys map to step.order |
| `## Step N: ... ### 本步骤规则` × N | All steps + all rules per step (适用条件 + 规则原文 + 补充描述) | The rule definitions to judge against |
| `## 最终输出汇总` | **Rewritten** — how to derive final_output from step_results | Aggregation guidance |
| `## 返回前检查` | **Rewritten** — 5 checks aligned to the new envelope | Self-check before emitting |

The "rewritten" sections are the ones whose content originally targeted the executor agent's `fired_rule_ids` / `blocking_rule_ids` / `terminal` shape; they're updated in place inside `lib/ontology-gen/v4/assemble-v4-4.ts` so the same `generatePrompt` call now produces an evaluator-ready prompt for the Full impl while continuing to serve the matchResume executor agent (which adopts the new envelope shape downstream).

#### `FOCUSING_SYSTEM_MESSAGE` (system message)

A short prefix (≈ 30 lines) that:

- Tells the LLM the user message comes from `generatePrompt` and is the authoritative spec.
- Reminds the four-value decision semantics (`not_started / passed / blocked / pending_human`).
- Reminds the evidence-grounding rule (only fetched instance data, byte-equal field paths).
- Reminds the four-section `rootCauseSections` requirement and JSONPath-lite field syntax.
- Reminds the strict `response_format` contract.

The system message does **not** reproduce any section already in the user prompt; it's purely a "how to read the user prompt" cue.

### 7.3 Step 8 — LLM call

#### MVP — single RuleJudgment

```ts
// lib/simple-rule-check/llm-client.ts
import OpenAI from "openai";

const RuleJudgmentSchema = z.object({
  ruleId: z.string(),
  decision: z.enum(["not_started", "passed", "blocked", "pending_human"]),
  evidence: z.array(z.object({
    sourceType: z.literal("neo4j_instance"),
    objectType: z.string(),
    objectId: z.string(),
    field: z.string(),
    value: z.unknown(),
  })),
  rootCause: z.string(),
  confidence: z.number().min(0).max(1),
  nextAction: z.string(),
});

const response = await openai.chat.completions.create({
  model: process.env.OPENAI_MODEL ?? "gpt-4o",
  messages: [
    { role: "system", content: SYSTEM },
    { role: "user", content: userPrompt },
  ],
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "RuleJudgment",
      schema: zodToJsonSchema(RuleJudgmentSchema),
      strict: true,
    },
  },
});
```

#### Full impl — per-step `StepResult` (Path C, active runtime)

At runtime the Full impl issues **N LLM calls per matchResume run**, one per `actionStep` with `rules.length > 0`. Each call asks the LLM for that step's `rule_judgments[]` only, using `StepResultJsonSchema` (a sub-shape of the historical envelope's `step_results.<step_N>` cell). The orchestrator concatenates the per-step results into a single `RuleCheckBatchRunAudited.results[]`.

The call is also **streaming**, with `stream_options: { include_usage: true }` so the final frame carries `prompt_tokens` / `completion_tokens`. The streaming switch was made because Kimi-k2.6 via new-api was 504-ing before completing the historical full-envelope (~10-15K-token) output. Per-step calls fit under the proxy timeout cleanly.

```ts
// lib/rule-check/llm-client.ts (active shape)

import { StepResultJsonSchema } from "./output-schema-audited";

const stream = await openai.chat.completions.create({
  model: process.env.OPENAI_MODEL ?? "gpt-4o",
  messages: [
    { role: "system", content: FOCUSING_SYSTEM_MESSAGE },
    { role: "user",   content: stepResolvedPrompt },     // generatePrompt({ focusStep: stepN })
  ],
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "StepResult",
      schema: StepResultJsonSchema,
      strict: true,
    },
  },
  stream: true,
  stream_options: { include_usage: true },
  // logprobs: false by default — opt-in via RULE_CHECK_LOGPROBS=1 env.
  // Composite confidence degrades gracefully when absent (see §7.5).
});

// Stream is assembled in llm-client.ts into a synthetic non-streaming
// response object compatible with the historical `response.choices[0]`
// shape that downstream Zod parsing expects.
```

**Path B**'s `MatchResumeEvalEnvelopeZod` + `renderEnvelopeSkeleton` survive only as the rendered output-schema-teaching block inside `/dev/generate-prompt`'s prompt preview — they are not used to decode runtime LLM output.

### 7.4 Step 9 — Validation (deterministic)

Each check is a pure function `(parsed, fetched, allRules) → boolean | tag`:

```ts
// validation/rule-id.ts
function validateRuleId(parsed, allRules): { ok: boolean; failures: string[] } {
  return allRules.some(r => r.id === parsed.ruleId)
    ? { ok: true, failures: [] }
    : { ok: false, failures: [`unknown_rule_id:${parsed.ruleId}`] };
}

// validation/evidence-grounded.ts
function validateEvidenceGrounded(parsed, fetched): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  for (const ev of parsed.evidence) {
    const inst = fetched.instances.find(
      i => i.objectType === ev.objectType && i.objectId === ev.objectId
    );
    if (!inst) {
      failures.push(`evidence_unknown_instance:${ev.objectType}/${ev.objectId}`);
      continue;
    }
    if (!(ev.field in inst.data)) {
      failures.push(`evidence_unknown_field:${ev.objectType}.${ev.field}`);
      continue;
    }
    if (!deepEqual(inst.data[ev.field], ev.value)) {
      failures.push(`evidence_value_mismatch:${ev.objectType}.${ev.field}`);
    }
  }
  return { ok: failures.length === 0, failures };
}

// validation/schema.ts
function validateSchema(raw): { ok: boolean; failures: string[]; parsed: RuleJudgment | null } {
  const result = RuleJudgmentSchema.safeParse(raw);
  return result.success
    ? { ok: true, failures: [], parsed: result.data }
    : { ok: false, failures: [`schema_invalid:${result.error.message}`], parsed: null };
}

// validation/block-semantic.ts — MVP returns skipped
function validateBlockSemantic(parsed, ruleClassification?): "ok" | "warning" | "skipped" {
  return "skipped";  // MVP
}
```

**Aggregate**:
```
overallOk = ruleIdExists && evidenceGrounded && schemaValid
         && (blockSemanticCheck === "ok" || blockSemanticCheck === "skipped")
```

**On failure**:
- `finalDecision.decision = "pending_human"`
- `finalDecision.overrideReason = validation.failures.join("; ")`
- Run is still persisted (failures are interesting data)

**No retry**. Failures are valuable signal — retrying masks LLM reliability data.

### 7.5 Confidence

**MVP** — `LLMSelfReported`: pass through `parsed.confidence` directly. Annotated in stored run as `confidenceSource: "llm_self_reported"`.

**Full** — `Composite`:

```
confidence = 0.4 × logprobScore
           + 0.3 × evidenceCountFactor
           + 0.3 × consistencyFactor
```

Where:
- `logprobScore = exp(logprob_of_decision_token)`  — from OpenAI `logprobs: true` response
- `evidenceCountFactor = min(evidence.length / 3, 1)`
- `consistencyFactor` = derived by re-prompting LLM to score "does each piece of evidence support the decision?" — a separate small LLM call returning per-evidence alignment scores

Confidence source is recorded in `RuleCheckRun.confidenceMeta`.

### 7.6 Step 10 — Decision routing (matchResume agent role)

Described for context. Not implemented in MVP — Checker just returns the `RuleCheckRun`; how a downstream agent acts on it is its concern:

```
switch (finalDecision.decision) {
  case "blocked":         // stop recommendation pipeline
  case "pending_human":   // suspend, queue for human review
  case "passed":          // continue to next step (scoring)
  case "not_started":     // rule didn't apply; continue, no flag
}
```

---

## 8. Rule coverage (MVP)

### 8.1 Test scenarios

**10 seeded candidates** in `RAAS-v1` domain, plus 2 jobs, plus 2 `Application` records (for 10-32). Each rule has a **positive** (expected to fire) and **negative** (expected NOT to fire) case.

| Rule | Positive case | Negative case |
|---|---|---|
| **10-7 期望薪资** | `C-MVP-001`: `expected_salary = null` → **pending_human** | `C-MVP-002`: `expected_salary = 60000`, job upper = 80000 → **passed** |
| **10-17 高风险回流** | `C-MVP-003`: work_experience 含 中软国际 + 离职编码 `A15` → **blocked** | `C-MVP-004`: work_experience 含 中软国际 + 离职编码 `A1` (正常) → **passed** |
| **10-18 EHS 回流** | `C-MVP-005`: work_experience 含 华腾 + 离职编码 `A13(1)EHS` → **pending_human** (需 HSM 评估) | `C-MVP-006`: 无华腾/中软国际历史 → **not_started** |
| **10-25 华为荣耀竞对** | `C-MVP-007`: 最近一段在 华为，end_date 一个月前 (< 3 月) → **pending_human** | `C-MVP-008`: 华为离职 end_date 8 个月前 (≥ 3 月) → **passed** |
| **10-32 岗位冷冻期** ★ cross-object | `C-MVP-009`: Application 有 `(C-MVP-009, JR-MVP-TENCENT-001, 2026-04-01, status="筛选淘汰")` (距今 ~6 周, < 3 月) → **not_started** | `C-MVP-010`: Application 有 `(C-MVP-010, JR-MVP-TENCENT-001, 2025-12-01, status="筛选淘汰")` (距今 ~5 月, ≥ 3 月) → **passed** |

For 10-32, the candidate fields themselves are otherwise "clean" (no blacklist hits, salary in range). The decision pivots **entirely** on the existence + timing of an `Application` record. This is the proof point Kenny is asking for: "show me a candidate that fails / passes a rule purely because of what's in the graph database, not what's in the resume."

### 8.2 Seed initialization

The graph database in `RAAS-v1` does NOT currently contain any of this data. `scripts/simple-rule-check-seed.ts` initializes it.

#### Seed order

1. **Schema verification** — `GET /api/v1/ontology/schema/objects?domain=RAAS-v1` to confirm the four DataObject schemas (`Candidate`, `Job_Requisition`, `Application`, `Blacklist`) exist with the expected PK fields. If any is missing, **fail with a clear error** pointing the user at the ontology repo to define them. The seed never auto-creates schemas (schema is the ontology repo's responsibility).
2. **Field-name discovery** — for each schema, capture the actual property keys (PK field name, value-typed fields). The seed adapts its POST payloads to these so it's robust to schema field-name drift. Stored as `seed.schemaSnapshot.json` (gitignored) for the run.
3. **Idempotent upsert** of:
   - 2 jobs: `JR-MVP-TENCENT-001` (腾讯 / WXG, salary upper 80000), `JR-MVP-BYTE-001` (字节 / AML)
   - 10 candidates as in §8.1
   - 2 `Application` records (C-MVP-009 / C-MVP-010 against `JR-MVP-TENCENT-001`)
4. **Verification probe** — re-fetch all written instances via `GET /api/v1/ontology/instances/{label}/{pk}?domain=RAAS-v1` and assert presence + field values match. Surfaces any silent server-side property-bag flattening surprises.

The seed is fully idempotent (PUT-via-POST upsert per ontology API contract); re-running ingests no duplicates. Cleanup is manual: `DELETE /api/v1/ontology/instances/...?domain=RAAS-v1` (not automated in MVP — accumulation is fine for a test domain).

#### Schema dependencies (must exist in `RAAS-v1` before seed runs)

| DataObject | Expected PK | Expected fields used by MVP (final field names TBD via §8.2 step 2) |
|---|---|---|
| `Candidate` | `candidate_id` | `name`, `gender`, `date_of_birth`, `expected_salary`, `work_experience` (array of `{ company, title, start_date, end_date, departure_code }`), `highest_education`, `skill_tags` |
| `Job_Requisition` | `job_requisition_id` | `client`, `department`, `title`, `salary_upper`, `required_skills`, `min_years_experience`, `age_max` |
| `Application` | `application_id` (or composite — discovered via schema introspection) | `candidate_id`, `job_requisition_id`, `client`, `application_date`, `status` |
| `Blacklist` | `blacklist_id` (or composite) | `candidate_id`, `client`, `reason`, `active` (reserved for v1.1, not used in MVP) |

If field names in the live schema differ from assumed, the seed adapter logs a clear diff and either remaps (if the difference is just naming) or aborts (if structurally incompatible).

### 8.3 Verification script

```bash
# 1. Confirm Ontology API reachable + schemas present
npm run simple-rule-check:seed:check                  # schema introspection only, no writes

# 2. Seed test data (idempotent)
npm run simple-rule-check:seed

# 3. Run all 10 cases (5 rules × pos/neg)
for case in '10-7:C-MVP-001:pending_human' \
            '10-7:C-MVP-002:passed' \
            '10-17:C-MVP-003:blocked' \
            '10-17:C-MVP-004:passed' \
            '10-18:C-MVP-005:pending_human' \
            '10-18:C-MVP-006:not_started' \
            '10-25:C-MVP-007:pending_human' \
            '10-25:C-MVP-008:passed' \
            '10-32:C-MVP-009:not_started' \
            '10-32:C-MVP-010:passed'; do
  IFS=: read rule cand expected <<< "$case"
  actual=$(npm run --silent simple-rule-check -- --rule $rule --candidate $cand \
            --client 腾讯 --job JR-MVP-TENCENT-001 --domain RAAS-v1 \
            --output decision-only)
  echo "[$rule/$cand] expected=$expected actual=$actual"
done
```

MVP demo passes iff **all 10 lines show `expected == actual`**.

---

## 9. Frontend / product UI

### 9.1 MVP — `/dev/simple-rule-check` (dev preview)

Layout (mirroring `/dev/generate-prompt`'s shape):

```
┌─────────────────────────────────────────────────────────────────┐
│ Runtime Rule Checker — dev preview                              │
│                                                                 │
│ ┌─ Run params ───────────────────────────────────────────────┐ │
│ │ actionRef: [matchResume]  domain: [RAAS-v1]           │ │
│ │ rule (dropdown of action's rules): [10-7]                   │ │
│ │ candidateId: [C-MVP-001]    jobRef: [JR-MVP-TENCENT-001]   │ │
│ │ client: [腾讯]               department (opt): [WXG]        │ │
│ │ [Run check]                                                 │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
│ ┌─ Result ──────────────────┐ ┌─ Trace (collapsible) ─────────┐│
│ │ ╔═════════════════╗       │ │ runId: 01HX...                ││
│ │ ║   PENDING       ║       │ │ timestamp: 2026-05-12T...     ││
│ │ ╚═════════════════╝       │ │ fetched.instances: [...]      ││
│ │                           │ │ prompt: <expand>              ││
│ │ Validation:               │ │ llmRaw: { ... }               ││
│ │  ✓ rule_id exists         │ │ llmParsed: { ... }            ││
│ │  ✓ evidence grounded      │ │ validation: { ... }           ││
│ │  ✓ schema valid           │ │ finalDecision: { ... }        ││
│ │  – block-semantic skipped │ └───────────────────────────────┘│
│ │                           │                                  │
│ │ Confidence: ████░░ 0.62   │                                  │
│ │                           │                                  │
│ │ Evidence:                 │                                  │
│ │ ┌─────────────────────┐   │                                  │
│ │ │ Candidate.expected_ │   │                                  │
│ │ │ salary = null       │   │                                  │
│ │ └─────────────────────┘   │                                  │
│ │                           │                                  │
│ │ Root cause:               │                                  │
│ │ 候选人未填写 expected_     │                                  │
│ │ salary 字段，依据 rule    │                                  │
│ │ 10-7 标记为薪资未知...     │                                  │
│ │                           │                                  │
│ │ Next action:              │                                  │
│ │ hold_for_manual_review    │                                  │
│ │                           │                                  │
│ │ Audit: data/simple-rule- │                                  │
│ │ check-runs/20260512/...   │                                  │
│ └───────────────────────────┘                                  │
└─────────────────────────────────────────────────────────────────┘
```

Purpose: engineering verification, not stakeholder demo.

### 9.2 Full — commercial product UI (Prove-centric)

The Full impl ships a polished product UI at `/rule-check/*`, integrated into the Agentic Operator app shell. The **dominant design principle** is **Prove**: every cell of UI must let the operator click-through to the underlying evidence — no claim is unfalsifiable.

The audit chain a user can traverse from any decision:

```
Decision → Validation report → LLM raw output → LLM prompt
                                                    │
                                                    ▼
                                                Action prompt (from generatePrompt)
                                                    │
                                                    ▼
                                                Fetched instances (from Ontology API)
                                                    │
                                                    ▼
                                                Source DataObject in Neo4j
```

Three primary views form the operator's daily path: **Aggregate** (which runs to triage?) → **Detail** (why did this run decide what it did?) → optional **Matrix** (which rule × which candidate failed across all runs?). The Aggregate page is the PRIMARY landing at `/rule-check`; Matrix is a secondary view at `/rule-check/matrix` (route swap locked 2026-05-13). Two locked design constraints (2026-05-13):

1. **No fabricated content.** Each run is rendered from its own audit JSON. No cross-run inference, no LLM re-invocation at render time (except the explicit Ask Why panel and the explicit Replay action), no synthesized result fields. Every client-side derivation is enumerated exhaustively in §9.3.
2. **Each run is independent.** The Aggregate dashboard's metrics are pure statistical summaries (counts, percentages, latency averages); they do not derive trends, regression alerts, or causal relationships across runs.

Route map (v3 — locked 2026-05-13):

| Route | Purpose |
|---|---|
| `/rule-check` | **运行汇总** — 1 row = 1 batch ("运行"); list + BatchPreview right pane — PRIMARY landing |
| `/rule-check/batches/[batchId]` | **单次运行详情** — verdict + stepCalls + candidate/job overview + step-grouped rule cards (with `规则原文` + 3-section judgment basis) — operator-level unit |
| `/rule-check/matrix` | Rules × candidates pass/fail matrix (secondary visualization; the "matrix exception" per §15) |
| `/rule-check/runs` | **308 redirect → `/rule-check`** (legacy URL stability) |
| `/rule-check/runs/[runId]` | **单条判定详情** — per-rule Prove page (8 layers; invariant — only the `RootCauseTimeline` band drop propagates from the global ruleRequirement removal) |
| `/rule-check/candidates/[id]` | Candidate-centric timeline |
| `/rule-check/rules` | **Static rule dictionary** (no run aggregation) |
| `/rule-check/audit` | Compliance + analytics |
| `/rule-check/settings` | Operator settings |

#### `/rule-check` — Runs aggregate (PRIMARY landing)

Triage view. Operator opens the app and sees a **run-centric overview**, scoped to the currently-selected (client, actionRef, optional rule/candidate filters). Three regions on one page; the bottom two columns are equal-height and scroll independently:

**Top — Header strip** (non-scrolling):
- Title `rc_aggregate_title` + scope label (e.g. `matchResume · 腾讯 · all runs`)
- Right-side actions:
  - **[Matrix view →]** link → `/rule-check/matrix` (secondary visualization)
  - **[↻ Run new batch]** button → opens `/dev/rule-check` in a new tab (locked 2026-05-13; no inline form in v1)

**Top — Dashboard strip** (non-scrolling):
- KPIs: total runs, passed%, blocked%, pending%, avg latency, 7-day sparkline of runs/day
- Filters bar: client, actionRef, domain, date range
- All numbers are pure aggregates over the runs index (§9.3 D3). No trends, no anomaly callouts, no regression detection.

**Bottom-left — Run list** (360px column; independent vertical scroll):
- Columns: timestamp, decision dot, rule, candidate
- Default sort: `timestamp` DESC (newest first)
- Plain `<table>`; revisit virtualization only when index size > 2000
- Click a row → preview panel updates (no navigation)

**Bottom-right — Preview panel** (flex-1; independent vertical scroll):
- Header: short runId · ISO timestamp
- Verdict block: DecisionBadge (md) + ConfidenceRing + rule / candidate / job / client metadata
- 结论摘要: `rootCauseSections.conclusion` (3-line clamp)
- 关键证据: up to 3 decisive evidence rows (`objectType.objectId.field`)
- Validation 4-light strip
- **★ 候选人主信息 (D8)** — key fields card pulled from Candidate (or Resume) instance: name / candidate_id / contact / DOB / gender / age / 学历 / 最近经历 / 技能
- **★ 其他 Neo4j 实例 (D8)** — collapsible list of remaining `fetchedInstances` (Candidate_Expectation / Application / Blacklist / etc.); default collapsed, click to expand raw JSON
- Bottom action: **[Open full detail →]** → `/rule-check/runs/<runId>`

Preview content is a **strict subset** of the audit JSON — never reformulated, never AI-summarized. See §9.3 D7 + D8.

#### `/rule-check/matrix` — Rules × Candidates matrix (secondary)

The "matrix exception" per §15. A single **rules × candidates pass/fail matrix**, scoped to the currently-selected (client, actionRef, domain). Color-coded cells, green/red at a glance.

- **Rows** — rules sorted by `step.order` then `ruleId`; grouped by step with sticky step header
- **Columns** — candidates sorted by ID
- **Cell** — colored by latest run's decision: passed (`--c-ok`), blocked (`--c-err`), pending_human (`--c-warn`), not_started (`--c-ink-3`). Empty (no run) = dashed transparent border.
- **Cell hover** — tooltip with runId / timestamp / decision
- **Cell click** — navigate to `/rule-check/runs/<runId>`
- **Top-strip KPIs**: total runs, passed%, blocked%, pending%, not_started%. Pure aggregation of the matrix's cells.
- **Header actions**: **[Runs →]** link → `/rule-check` (primary) · **[↻ run new batch]** → `/dev/rule-check`
- Per-cell rerun is **not** offered here (Replay is detail-page only).

Matrix cell rule: each cell represents the **latest run** per `(rule, candidate)` pair, by `timestamp`. Historical re-runs remain accessible from `/rule-check` (Aggregate). See §9.3 D4.

#### `/rule-check/runs` — Legacy URL (308 redirect)

This path was the Aggregate page's home prior to the 2026-05-13 route swap. Now serves a permanent (HTTP 308) redirect to `/rule-check`. No content drift; the redirect is implemented via `next/navigation`'s `redirect()` server helper.

#### `/rule-check/runs/[runId]` — Run detail (the "Prove" page, 8 layers)

The central page. Vertical scroll with **8 stacked layers**:

**Layer 1 — Verdict hero**
- DecisionBadge (xl) + ConfidenceRing + candidate / rule / job / client / timestamp / runId
- Sticky breadcrumb
- Top-right page actions: **[↻ Replay this case]** (§14.2) · **[← back]**

**Layer 2 — Inference Chain** ★ NEW (2026-05-13)
- Horizontal SVG strip with three node classes:
  - **Rule node** (leftmost, fixed): ruleId, canBlock flag, step number, 1-line spec excerpt (from `fetched.rule`)
  - **Evidence nodes** (middle, N nodes — one per `decisive=true` evidence): `objectType` / `objectId` / cited field / cited value / grounded ✓-✗ / `#idx <fetchedInstanceIndex>`
  - **Verdict node** (rightmost, fixed): decision color band, confidence%, nextAction
- Arrows are pure SVG paths colored by verdict (passed=green, blocked=red, pending_human=amber, not_started=gray). **No edge labels** — the audit JSON carries no relationship field; visual flow only.
- **Inline fact card expansion** (locked 2026-05-13): clicking any node expands it in-place to its full fact card form. **Multiple cards may be expanded simultaneously**; the SVG chain re-flows vertically to accommodate. Drawer pattern is explicitly NOT used.
- **Degraded chain** — when `evidence[]` is empty (pending_human / not_started with no data): renders `Rule → ⊘ no decisive evidence → Verdict`. Honest visual signal that no data supported the verdict.
- **Cross-references** between evidence are surfaced **only inside fact cards' §⑤ section** (§9.3 D1); they are NOT drawn as edges on the chain (locked 2026-05-13).

Each fact card has a *collapsed* form (the in-chain node) and an *expanded* form (in-place, same x-position, vertical growth):

| Section | Source field |
|---|---|
| Header | `<objectType> · <objectId>` + decisive dot |
| ① Cited slice | `evidence[i].{field, value, decisive, grounded}` |
| ② Rule binding | `fetched.rule.{name, spec, canBlock}` |
| ③ Source receipt | `ontologyApiTrace[j]` matched to `fetchedInstanceIndex` (heuristic; see §9.3 D2) |
| ④ Raw JSON | `fetched.instances[fetchedInstanceIndex]` with cited field highlighted |
| ⑤ Cross-references | Client-side derived from `fetched.instances` field equality (§9.3 D1) |
| ⑥ Verify externally | "Open in Neo4j Browser" link (env: `NEXT_PUBLIC_NEO4J_BROWSER_URL`) + "Copy as Cypher" fallback |

Collapsed-form border tint:
- `decisive=true & grounded=true` → 1px solid `--c-ok` 25% mix
- `decisive=true & grounded=false` → 2px solid `--c-err` + ⚠ corner badge (the hallucination signal)
- `decisive=false` → 1px solid `--c-line` (informational, dimmed)
- `grounded=undefined` → 1px dashed `--c-ink-4`

All six expanded-form sections render from the run's audit JSON or LLM-independent derivations. No section requires LLM re-invocation.

**Layer 3 — Why this verdict (Root cause narrative)**
- The LLM's **four-section rootCauseSections** rendered as 4 prose blocks:
  - 【规则要求】(blue band) — what the rule demands
  - 【数据观察】(neutral band) — what was read
  - 【对照推理】(amber band) — the reasoning step
  - 【结论】(decision-color band) — verdict + why-not-other-three
- In the 数据观察 block: bracketed IDs matching the regex `\[([A-Z][a-zA-Z0-9-]+)\]` are turned into clickable chips when they correspond to an `evidence[].objectId` in this run. Click → scroll to + highlight the matching L2 chain node. See §9.3 D5.

**Layer 4 — Evidence ledger**
- Full list of `evidence[]` (decisive + informational) as cards (`EvidenceCard` atom)
- Filter: "show only decisive" vs "all"
- Each card: object icon + `objectType` / `objectId` + field path, value with byte-equal source highlight, `decisive` and `grounded` indicators, "Source" link to the raw HTTP exchange in `ontologyApiTrace[j]`

**Layer 5 — Counterfactuals** ★ NEW (2026-05-13)
- Renders `llmParsed.counterfactuals[]`. Hidden if absent.
- Each row: `hypotheticalChange` text → `predictedDecision` badge + confidence bar
- Header explicitly labels these as **LLM-speculative** — not new claims, not run again, just surfacing what the LLM's audit envelope already declared.

**Layer 6 — Validation strip**
- Four-light board (rule_id / evidence_grounded / schema / block_semantic)
- Each light click expands to show the deterministic check's failures with line-level detail
- `evidence_grounded` hovering: deep-equal diff if value mismatched
- `block_semantic`: link to Rule node's classification metadata

**Layer 7 — Prompt + Response (the receipts)**
- **Prompt panel** (collapsible, default-collapsed):
  - 3-tab view: Resolved prompt / Source actionObject / Diff (drift detection between run-time prompt and current `generatePrompt` output)
  - Actions: "Copy prompt" / "Export as `.md`" / "Replay" (same Replay flow as L1; see §14.2)
- **LLM response panel** (collapsible, default-collapsed):
  - Raw JSON response with token boundaries (when logprobs captured)
  - Parsed envelope rendered side-by-side
  - Model + latency + token counts + cost USD
  - If `RULE_CHECK_LOGPROBS=1` was set for the run, inline mini-chart of per-token logprob; clicking the "decision" token shows its top-5 alternatives

**Layer 8 — Ask why Q&A**
- LLM-powered audit assistant grounded **only** in this run's trace JSON
- Pre-canned questions surfaced from L5 counterfactuals when present; plus "为什么不是 blocked？", "evidence[2] 是从哪条 instance 来的？", etc.
- Counterfactual answers explicitly labelled as **speculation**
- Ask-history appended to the run's audit JSON

**Footer actions**
- **Human override** — operator with permission overrides `pending_human` → `passed` / `blocked`; override + reason + identity appended to trace
- **Bundle for compliance** — exports a single signed `.json.zip` with run + prompt + LLM raw + Ontology API calls + screenshot
- ~~Re-run latest in-place~~ — **replaced** by L1's `[↻ Replay this case]` which creates a new independent runId (see §14.2). No in-place mutation of the existing run.

#### `/rule-check/runs/[runId]/compare/[otherRunId]` — Diff view (deferred)

**Status (2026-05-13)**: deferred from v1 scope. Replay creates new runIds (§14.2); pairwise diff between two runs is reserved as a follow-up if operator workflows demand it. Until then, users compare runs by opening two detail pages in separate tabs or diffing audit JSON via `jq`/`diff` on disk.

#### `/rule-check/candidates/[id]` — Candidate-centric

- Candidate profile + parsed resume preview (read-only)
- Timeline of all rule checks across jobs/clients — chronological run list
- Aggregate stats: pass rate, top blocking rules, average confidence
- "Run new check" inline form

#### `/rule-check/rules` — Static rule dictionary

Pure reference catalog (locked 2026-05-13). Operators look up rule definitions; **no run aggregation, no firing rate, no recent runs, no "where this rule fired"** — those patterns aggregate by rule globally and violate §15's "run is the smallest unit" rule.

- Data source: `listActiveRules` server action → `FetchedRuleClassified[]` from Ontology API (scope: actionRef × client × domain)
- Filter chips by `step.order`; free-text search by `id` / `name`
- Per rule card:
  - Header: `<rule.id>` · `Step <stepOrder>` chip · `canBlock` badge (when present) · scope badge
  - Body: `<rule.name>` (bold) + `<rule.sourceText>` (3-line clamp; expand button when long)
- Fallback when Ontology API unreachable: empty list, no false aggregation

Explicitly NOT present (would violate §15):
- ✗ Firing rate / decision split histograms
- ✗ "Last N firings" / linkbacks into runs
- ✗ Per-rule LLM reliability stats (would imply rule-as-aggregation-axis)

Per-rule reliability and cross-run firing trends, when needed, belong in `/rule-check/audit` (compliance/analytics, separately scoped, possibly backed by an out-of-Ontology analytical store per §10.2).

#### `/rule-check/audit` — Compliance + analytics

- **Compliance reports**: PDF/XLSX export of "all blocked decisions for Tenant X in date range Y", suitable for legal/HR
- **Cross-run analytics**: rule firing trends, LLM reliability over time, prompt-drift incidents
- **Org-wide dashboards**: customizable widgets pulling from the out-of-Ontology external store (TBD: OpenSearch / ClickHouse / etc.)

#### `/rule-check/settings` — Operator self-service

- Default model / temperature / timeout
- Confidence threshold for "low confidence" alerts
- Per-rule override: "always require human review for rule X"
- API tokens management (Ontology + LLM)

**Design system**: reuses existing `--c-*` OKLCH tokens in [app/globals.css](app/globals.css), atom components in [components/shared/atoms.tsx](components/shared/atoms.tsx) (`StatusDot`, `Spark`, `Metric`, `Badge`, `Btn`, `Card`, `CardHead`), iconography from [components/shared/Ic.tsx](components/shared/Ic.tsx). Existing rule-check atoms reused: `DecisionBadge`, `ConfidenceRing`, `EvidenceCard`, `ValidationLight`, `PromptPanel` (3-tab), `ResponsePanel`, `LogprobInlineChart`, `RootCauseTimeline`, `AskWhyChat`. New components to be built (2026-05-13): `MatrixGrid` (rules × candidates), `RunsDashboard` (top strip), `RunsList` (virtualized list), `RunsPreview` (right panel), `InferenceChain` (SVG strip + node positioning + arrow re-flow on expansion), `FactCard` (collapsed + expanded states), `CounterfactualsList`.

### 9.3 UI Derivations (留痕清单)

The UI computes a small set of presentation-time helpers from the audit JSON. None of these are "new result content" — they are read-only views over existing fields, and **none alter `RuleJudgmentAudited.decision` or any other persisted field**. Each is enumerated below so audit reviewers can distinguish "this came from the LLM" vs "this is a UI rendering choice".

**Locked policy (2026-05-13)**: the UI MUST NOT generate new result content. It MUST NOT invoke the LLM at render time except via the explicit Ask Why panel (Layer 8) and the explicit Replay action (§14.2). The derivations enumerated below are the complete, exhaustive set permitted.

| # | Derivation | Input fields | Output | Where rendered | Affects verdict? |
|---|---|---|---|---|---|
| D1 | Cross-references within a run | `fetched.instances[]` (same run only) | List of "this instance shares `<field>` value with instance #idx N" pairs | Fact card §⑤ only (NOT drawn on the inference chain) | No |
| D2 | `fetchedInstanceIndex` → trace entry mapping | `ontologyApiTrace[]` URL strings + `instances[i].objectType / objectId` | First matching trace entry per index (ambiguous matches flagged) | Fact card §③ Source receipt | No |
| D3 | Aggregate metrics | `data/rule-check-runs/*.json` filesystem index | Total / passed% / blocked% / pending% / avg latency / runs-per-day sparkline | `/rule-check` aggregate dashboard strip; `/rule-check/matrix` top-strip | No |
| D4 | Matrix cell selection | Multiple runs for the same `(rule, candidate)` | Latest run (`max(timestamp)`); older runs still accessible from `/rule-check` (aggregate) | `/rule-check/matrix` cells | No |
| D5 | RootCause data-observation chips | `rootCauseSections.dataObservation` text + `evidence[].objectId` | Regex-extracted bracketed IDs (`\[([A-Z][a-zA-Z0-9-]+)\]`) replaced with clickable chips when they match an evidence object | Layer 3 narrative panel | No |
| D6 | Replay | This run's `input` (candidate/job/client/dept/domain/ruleId) | Invokes `checkRule()` / `checkRules()` with the same args → **new independent runId** | Layer 1 top-right action button | No (creates new run; old run unchanged) |
| D7 | Preview summary | This run's `finalDecision`, `rootCauseSections.conclusion`, `evidence[].filter(decisive)` (top 3), `validation` | Concise card with conclusion text + 3 decisive evidence rows + 4-light validation strip | `/rule-check` aggregate preview panel | No (strict subset of audit JSON; no reformulation) |
| D8 | Preview expanded instances | This run's `fetched.instances[]` (full as persisted) | Candidate main fields card (`name`, `candidate_id`, `email`, `phone`, `date_of_birth`, `gender`, `age`, `highest_education`, recent `work_experience`, `skill_tags`) + collapsible list of remaining instances (Candidate_Expectation, Application, Blacklist, etc.) with raw JSON | `/rule-check` aggregate preview panel | No (strict projection; no reformulation) |
| D9 | Batch-level projections (v3) | `RuleCheckBatchRunAudited` JSON: `aggregateDecision`, `stepCalls[]`, `results[]` grouped by `fetched.rule.stepOrder`, `results[0].fetched.instances[]` for candidate/job overview | `BatchRow` (1 row per batch on `/rule-check`) + `BatchSummary` (full payload for `/rule-check/batches/[batchId]`: verdict + stepCalls slim + candidate/job overview + step-grouped rule entries with `sourceText` + 3-section judgment basis) | `/rule-check` list + preview; `/rule-check/batches/[batchId]` detail page | No (strict subset of `RuleCheckBatchRunAudited` + denormalized `RuleCheckRunAudited`; no reformulation; helper picks live in `lib/rule-check/instance-overview.ts` for server-side use) |

**D1 — Cross-references, detailed**. For each instance in `fetched.instances`, iterate its fields; for fields whose name ends in `_id` or equals `id`, scan other instances in the same run for any field with the same string value. Emit pairs `(thisIdx, field, otherIdx, otherField)`. This is purely structural join — it does NOT imply that a Neo4j edge exists between the nodes (the audit JSON carries no relationship field). The UI surfaces this only inside fact cards (§⑤), never as visual edges on the inference chain (locked 2026-05-13). Acceptable as a derivation because:
- It operates entirely within one run's `fetched.instances` — no cross-run inference
- The output is a hint ("these two records share an identifier"), not a claim
- The user can verify via the raw JSON in fact card §④

**D2 — Trace mapping heuristic**. The audit JSON does NOT carry an explicit `fetchedInstanceIndex → traceEntryIndex` map. Mapping is done by matching `instances[i].objectType` and `objectId` substring in the trace's `requestUrl`. If multiple trace entries match (e.g., a refresh fetched the same object twice), the UI takes the **first** match and shows a small "ambiguous" badge in fact card §③. Acceptable because trace entries themselves are not altered; the receipt is shown verbatim from the audit log.

**D3 — Aggregate metric scope**. Aggregates are pure counts / averages / sparklines over the runs index. The dashboard MUST NOT compute: trend lines, anomaly alerts, regression detection between runs, predicted future outcomes, or any other inter-run inference. Each run is independent. Cross-run analytics (rule firing trends, drift detection) belong in `/rule-check/audit` as a clearly-distinct page and use an out-of-Ontology external store (§10.2).

**D4 — Matrix cell "latest" tiebreak**. If two runs for the same `(rule, candidate)` share a timestamp exactly (unlikely given UUIDv7 monotonicity but possible under clock drift), tiebreak by lexicographic `runId` DESC. The matrix UI surfaces only the chosen cell; the runs list at `/rule-check` (Aggregate) shows all of them.

**D5 — Chip extraction safety**. The regex `\[([A-Z][a-zA-Z0-9-]+)\]` is intentionally strict: starts with uppercase letter (Application, Resume, Job, etc.), no spaces. Bracketed text that doesn't match an `evidence[].objectId` is left as plain text; no false-positive chip is rendered.

**D6 — Replay isolation**. A Replay-triggered run is a fully independent run with its own runId, prompt, fetched instances, LLM response, and audit JSON. The replay button passes the **original** run's `input` shape; it does NOT inherit the original run's verdict, evidence, or validation report. The original run's audit JSON is never mutated.

**D7 — Preview content provenance**. Every field in the preview maps 1:1 to a field in the audit JSON. The preview MUST NOT reformulate `conclusion` text, summarize evidence with new wording, or compute any derived field beyond simple subset selection (top-3 by `decisive=true` filter). If the operator wants a richer view, they click `[Open full detail →]`.

**D8 — Preview expanded instances**. The aggregate preview's `候选人主信息` card pulls hand-picked common fields from the Candidate instance (or Resume as fallback) in `fetched.instances[]`: `name`, `candidate_id`, `email`, `phone`, `date_of_birth`, `gender`, `age`, `highest_education.{school,degree,major}`, `work_experience[0].{company,title,start_date,end_date}`, `skill_tags[]` (head 8). Missing fields are silently skipped — no synthesis. The `其他 Neo4j 实例` section lists ALL `fetched.instances` minus {Candidate, Resume, Job_Requisition} (which are represented in the verdict block or candidate card already), each as a collapsible card with `<objectType> · <objectId>` header and click-to-expand raw `data` JSON. **Strict subset of audit JSON**; no reformulation, no Ontology API re-fetch, no LLM invocation. If the operator wants more, they click `[Open full detail →]` for the 8-layer Prove page.

---

## 10. Audit + Q&A reuse

### 10.1 MVP — trace replay

Engineers inspect `data/simple-rule-check-runs/<YYYYMMDD>/<runId>.json` directly. No automated Q&A. Replay = re-run with same CLI args.

### 10.2 Full — LLM-driven Q&A

Run-detail page's "Ask why" panel:

```
[system]
你是审计员。基于下面的 RuleCheckRun trace 回答用户问题。
- 只能引用 trace 内的数据，不允许猜测
- 如果 trace 中没有答案，明确说明
- 如果用户问的是反事实（"如果 X 不同会怎样"），明确这是猜测并说明根据

[user]
Trace (full RuleCheckRun JSON):
{{runJson}}

问题: {{userQuestion}}
```

Cross-run analytics (e.g., "all C-MVP-007 runs where 10-25 fired, last 30 days") run against an **out-of-Ontology external store** TBD (object storage / OpenSearch / ClickHouse / etc., full impl only). The Ontology API is **never** written to by the Checker — see §2 Non-goals.

---

## 11. Error modes + handling

| Failure | MVP behavior | Full impl behavior |
|---|---|---|
| Ontology API: candidate not found in domain | Return `pending_human` with overrideReason `candidate_not_found`; persist run | Same |
| Ontology API: required DataObject schema missing in domain (seed-time) | Seed script fails fast with explicit error: "DataObject <label> not defined in <domain>; create via ontology repo or POST /api/v1/ontology/objects"; no auto-create (prevents prod accidents) | Same |
| Ontology API: Application list returns 0 rows for 10-32 candidate | Pass empty array to LLM as evidence; LLM should output `decision="not_started"` (no cooldown applies because the precondition — an Application exists — isn't met). NOT a Checker error. | Same |
| Ontology API: auth/timeout error | Throw `OntologyGenError`; caller handles | Same |
| LLM API: 5xx / timeout | 1 retry with exponential backoff; on 2nd failure return `pending_human` with overrideReason `llm_unreachable`; persist run | Same. **504 / 502 are explicitly NOT retried** (proxy upstream timeout — retry will almost always re-fail; wastes ~15min per attempt). |
| LLM API: 429 rate limit | Respect `Retry-After`; 1 retry; same fallback | Same |
| LLM output: malformed JSON (envelope unparseable) | Caught by Zod in `validateSchema`; counted as `schema_invalid` failure | **Single envelope corrupt → all rules fall back to `pending_human`** (this is the cost of Path B; Path A backup avoids it). Persist run with envelope-level failure tag `envelope_invalid:<zod-error>`. |
| LLM output: envelope OK, single rule_judgment malformed | N/A | **Per-rule validation failure** — only the offending rule_judgment is overridden to `pending_human`; other rules keep their decisions. Per-judgment failure tag attached. |
| LLM output: envelope's `final_output.aggregateDecision` disagrees with deterministic re-derivation from `rule_judgments[]` | N/A | Trust the deterministic re-derivation (the source of truth); mark a soft warning `aggregate_mismatch` in the run's validation report. LLM's claimed aggregate is preserved for audit but not honored. |
| Validation failure (any kind) | No retry. Record failure, override to `pending_human`. Run persisted. | Same — but applied per-judgment, not envelope-wide. |
| Filesystem write failure | Log + propagate; return RuleCheckRun in-memory; caller warned | Same |

---

## 12. Environment + dependencies

### `.env.example` additions

```
# OpenAI (or compatible — set OPENAI_BASE_URL to point at OpenRouter etc)
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o
```

### `package.json` additions

```json
{
  "dependencies": {
    "openai": "^4.x",
    "zod": "^3.x",
    "uuid": "^10.x"
  },
  "scripts": {
    "rule-check": "node --env-file=.env.local --import tsx scripts/simple-rule-check.ts",
    "rule-check:seed": "node --env-file=.env.local --import tsx scripts/simple-rule-check-seed.ts",
    "rule-check:seed:check": "node --env-file=.env.local --import tsx scripts/simple-rule-check-seed.ts --check-only"
  }
}
```

### `.gitignore` additions

```
# simple-rule-check (MVP) audit traces
data/simple-rule-check-runs/

# rule-check (full impl, when built) audit traces
data/rule-check-runs/
```

---

## 13. Verification

No automated test suite (per CLAUDE.md). MVP verification:

1. **TypeScript build** — `npm run build` green (Next 16 = tsc --noEmit + lint)
2. **Schema check** — `npm run simple-rule-check:seed:check` confirms all four DataObject schemas (`Candidate` / `Job_Requisition` / `Application` / `Blacklist`) exist in `RAAS-v1` with expected PK fields
3. **Seed data POST** — `npm run simple-rule-check:seed` creates 2 jobs + 10 candidates + 2 Application records; verify count via Ontology API listing endpoints
4. **10 expected outcomes** — script per §8.3; all 10 lines show `expected == actual`
5. **Cross-object proof point (10-32 explicit demo)** — for `C-MVP-009`, the audit JSON must show:
   - `fetched.instances` includes an `Application` object
   - `llmParsed.evidence` cites that `Application.<id>.status = "筛选淘汰"` (or schema-equivalent field)
   - `validation.evidenceGrounded = true`
   - `finalDecision.decision = "not_started"`
   This is the "graph proof" Kenny needs — written into the audit record verbatim.
6. **Validation trip test** — manually inject a Mock LLM response that hallucinates evidence (e.g., a non-existent `Application` object id); verify `validation.evidenceGrounded = false` and `finalDecision.decision = "pending_human"` with `overrideReason` populated
7. **Dev UI smoke** — `npm run dev`; open `/dev/simple-rule-check`; run one MVP case (including 10-32); verify all panels render, including the Application evidence card
8. **Audit replay** — open one persisted JSON; verify all expected sections present

---

## 14. Open questions / future work

1. **Rule classification persistence** — hand-coded switch in `simple-rule-check`. Future `rule-check`: store `required_instances` + `can_block` metadata on Rule nodes in Ontology API (read-only, owned by the ontology repo — we never write these from the Checker). Coordinate with ontology repo for schema extension.
2. ~~`RuleCheckResult` DataObject schema~~ — **dropped.** Per §2 Non-goals the Checker never writes Neo4j instances. If we need queryable analytics across runs, the storage substrate will be an external store (filesystem index, object storage, OpenSearch, ClickHouse, etc.) — **not** the Ontology API.
3. **LLM provider abstraction** — MVP locks OpenAI Chat Completions structure (compatible with OpenRouter etc via `OPENAI_BASE_URL`). If we want to A/B different providers natively, add an `LLMClient` abstraction layer.
4. **Cost tracking** — token + latency + USD-cost recorded per run; aggregate dashboard widget in full impl.
5. **matchResume agent** — production agent that orchestrates steps 1-10 is separate future work. This SPEC defines only Checker (steps 6-9 in agent's flow).
6. **`rule-check` (full impl) module** — currently a partial scaffold at `lib/rule-check/` (envelope schema mid-flight). To be completed per locked decisions in §15: single LLM call producing execution envelope per §6.3.
7. **step4 scoring field** — Per locked decision 2026-05-12, the `score` field is **temporarily omitted** from generatePrompt's output schema for step4 rule_judgments. To be re-added once scoring spec is finalized. Until then, downstream consumers (rule-check + matchResume executor) must not require `score` to be present.
8. **matchResume executor agent adoption of new envelope shape** — `generatePrompt`'s rewritten output schema (execution envelope per §6.3) is a breaking change for any external matchResume executor agent (e.g. the Inngest worker described in `rule-check-end-to-end-workflow.md`). External worker must be updated in coordination with this SPEC change. Until coordination lands, the Full impl runs only against Trust UI / `/dev/rule-check`, not in production matchResume agent flows.

### 14.1 Backup paths (alternative call topologies)

These were evaluated during design (2026-05-12) and **not selected** for the Full impl baseline, but are documented here so we can pivot without redoing the analysis if Path B (the chosen "execution-shaped single-call" topology) proves unsustainable in production.

#### Path A — Per-rule parallel (backup)

| | |
|---|---|
| Topology | N parallel LLM calls, one per rule. Each call evaluates a single rule and outputs a single `RuleJudgmentAudited`. Orchestrator gathers all judgments into the `RuleCheckBatchRunAudited`. |
| Pros | Wall-clock = max single-rule latency (~seconds), not sum. Per-rule fault isolation. Streaming-friendly UI. |
| Cons | N× input token cost (job/resume sent per call). Loses the "one execution = one envelope" mental model alignment with matchResume executor agent. |
| When to pivot | If Path B's single envelope keeps hitting provider 504s, output-size limits, or strict-schema enforcement bugs that can't be resolved at the provider layer. |
| Impact on `generatePrompt` template | Same rewritten output schema can still be reused — Path A's orchestrator would target a **single-judgment subset** of the envelope shape per call. No second template needed. |

#### Path C — Per-step sequential (**ACTIVE RUNTIME**, locked 2026-05-13)

| | |
|---|---|
| Topology | `actionSteps.length` LLM calls, executed **sequentially** in `step.order`. Each call produces one step's `rule_judgments[]` via `StepResultJsonSchema`. |
| Short-circuit | If any rule in step N returns `decision: "blocked"` AND `rule.canBlock !== false`, the orchestrator skips remaining steps and synthesizes `not_started` runs for their rules (`overrideReason = "short_circuit:step_<N>:rule_<id>"`), so the matrix / aggregate views still get a full grid. |
| Pros | Preserves step boundary semantics. Per-call output is bounded by `step.rules.length` (typically 2-4 rules) → fits under proxy timeouts (the 504 issue that killed Path B). Streaming + `stream_options.include_usage` per call. Short-circuit saves LLM cost on terminal rules. |
| Cons | More wall-clock latency than Path A's parallelism. Aggregation logic stitches step_results across responses (handled in `lib/rule-check/orchestrator/all-in-one.ts`). |
| Why it won | Kimi-k2.6 via new-api 504'd on Path B's full-envelope output. Sequential per-step output stays under proxy timeout. Decision logged in §15 (2026-05-13). |

#### Agentic dynamic fetch (含义 B, future work)

A separate evaluation dimension from Path A/B/C: **how does the system know which Ontology instances to fetch per rule?**

| | |
|---|---|
| Approach | Give the LLM a `query_neo4j(objectType, filter)` tool. LLM iteratively requests data until it has enough to judge, then emits the rule_judgment. |
| Status | **Not selected**. matchResume rules are structurally enumerable (decided 2026-05-12). 含义 A1 (hand-coded `instancesNeededForRule(ruleId)` switch) covers all known rules with one map entry per rule. |
| When to revisit | When the rule set grows beyond what's practical to hand-maintain, OR when rule forms become highly heterogeneous (e.g. arbitrary SQL-like data dependencies declared in rule sourceText). Until then,含义 A1 stays. |
| Risk if adopted prematurely | LLM hallucinates filters; fetch traces become non-deterministic; audit story weakens. |

### 14.2 Replay design

Operator-facing action attached to the Run detail page's Layer 1 (top-right `[↻ Replay this case]` button). Locked behavior (2026-05-13):

- **Input** — the displayed run's `input` payload (`candidateId`, `jobRef`, `client`, `clientDepartment`, `domain`, `ruleId` for single-rule view, or batch's `ruleIds`).
- **Execution** — invokes the same orchestrator as a fresh run: `checkRule()` for single-rule view, `checkRules()` for batch context. **Same arguments, no flags carried over** (logprobs / debug env vars take their current process values, not the original run's).
- **Output** — a **new independent runId**. The original run is preserved as-is on disk (`data/rule-check-runs/<YYYYMMDD>/<oldRunId>.json`) and remains accessible via the runs list / matrix. No mutation of the original audit JSON.
- **Navigation** — on success, route to `/rule-check/runs/<newRunId>`. On error, show toast + keep current page (button re-enabled).
- **Button state** — `[⟳ Running… 03:42]` elapsed timer during the LLM call (same formatter as `/dev/rule-check`).

**Side-by-side diff is explicitly out of scope for v1**. The previous draft of §9.2 referenced a `/rule-check/runs/[runId]/compare/[otherRunId]` diff page; that page is documented but not built in v1. Replay always creates a fresh runId — users compare runs by opening the two detail pages in separate tabs or via filesystem audit JSON diff (`jq` / `diff`). A dedicated diff component is reserved as a follow-up if operator workflows demand it.

**Rationale**: keeping Replay as "fresh runId, no diff" preserves the audit invariant that each run is fully independent — no run's audit JSON is mutated by a later run, and the run-to-run relationship is purely sequential by timestamp (not parent/child). This is the same invariant enforced by §9.3 (UI Derivations) and the §15 "UI derivations policy" decision row.

### 14.3 Deferred prompt-side optimizations

- **`P4`** — remove the in-prompt JSON skeleton (`## 最终输出 JSON 结构` body). Deferred per §6.4 cross-check decision: no conflict between skeleton and strict schema; removing it would save ~2K input tokens but not address output-volume timeout. Trigger only if a future provider mandates schema-only OR input-size becomes critical for an unrelated reason. **STATUS: still deferred (2026-05-13).**
- **Path C** — per-step batching (sequential LLM calls, one per `actionStep`, each producing a `StepResult`; orchestrator-controlled short-circuit on red-line). Originally documented here as the natural fallback when full-batch matchResume continues to 504 on the chosen provider. **STATUS: LOCKED 2026-05-13.** Path C is now the active runtime contract; see §6.3 Path C addendum + §15 decision log rows for full semantics. The historical Path B envelope shape remains documented in §6.3 for context and is still produced by `renderEnvelopeSkeleton` for `/dev/generate-prompt` review.

---

## 15. Decision log (locked)

| | |
|---|---|
| Module naming | MVP module: `lib/simple-rule-check/` (shipped, frozen). Full impl module: `lib/rule-check/` (placeholder, not yet built). The MVP is preserved as a separate module so we can A/B against the full impl when ready. |
| Decision enum | Locked to four values: `not_started \| passed \| blocked \| pending_human`. Older drafts mentioned `pass / block / pending / warning / not_applicable`; those are obsolete. |
| Ontology API write policy | **Forbidden.** Rule Checker is a read-only consumer; never writes any DataObject (incl. RuleCheckResult). Seed scripts write at bootstrap only. |
| Full impl prompt source | **`rule-check` MUST consume `generatePrompt`'s output verbatim** — no section discarding, no post-processing strip. If a section is inappropriate for the eval consumer, the right fix is to **modify `generatePrompt`'s template**, not to bypass it. `simple-rule-check` keeps the extractor strategy as the baseline for A/B. Locked: 2026-05-12. |
| Full impl LLM call mode (**Path B**) | **One LLM call evaluates all rules**, producing an execution-shaped envelope (`step_results.*.rule_judgments[]` + `final_output`) per §6.3 — same envelope shape consumed by the matchResume executor agent. Accepted risk: large structured output, single-envelope all-or-nothing failure mode. Path A (per-rule parallel) and Path C (per-step batching) are documented backup paths in §14.1 if Path B proves unsustainable. Locked: 2026-05-12. |
| `generatePrompt` output schema rewrite | **`generatePrompt`'s `## 最终输出 JSON 结构` is rewritten** so that the LLM output envelope embeds `rule_judgments[]` per step (RuleJudgmentAudited shape per §6.3) plus `final_output { aggregateDecision, terminal, triggeredRules, notifications }`. The same envelope serves both `rule-check` (eval) and matchResume executor agent (production). `renderConstraints` / `renderBeforeReturn` / `renderFinalConsolidation` in `assemble-v4-4.ts` are updated in sync. Locked: 2026-05-12. |
| step4 scoring field | **Temporarily omitted** from generatePrompt's output schema. To be reintroduced when scoring spec is finalized. Until then, downstream consumers MUST NOT depend on `score`. Locked: 2026-05-12. |
| Dynamic Neo4j fetch dispatch (含义 A1) | **Hand-coded `instancesNeededForRule(ruleId)` switch**, sibling-copied from `lib/simple-rule-check/rule-instance-map.ts` into `lib/rule-check/`. Future v1.1 may shift to ontology-driven `rule.dependencies` (same渐进 pattern as `can_block` in [fetch-rules.ts](../lib/rule-check/fetch-rules.ts)). Agentic tool-calling (含义 B) deferred per §14.1. Locked: 2026-05-12. |
| Block-semantic dependency | Block-semantic check requires Rule classification metadata (`can_block`, `required_instances`) on Rule nodes. **We will push the ontology repo to extend the Rule schema in v1.1**; `rule-check` reads only — never writes. This is the one external dependency that must clear before block-semantic check can ship. Locked: 2026-05-12. |
| Generator vs Checker | Two independent modules; share Ontology API as upstream rule source |
| MVP prompt strategy | Extracted single rule + execution wrapper |
| Full prompt strategy | **Verbatim** `generatePrompt` output as user message + small FOCUSING_SYSTEM_MESSAGE. `generatePrompt`'s template itself is rewritten so its output schema embeds `rule_judgments[]` per step (no section discarding required). |
| MVP call pattern | One LLM call per rule |
| Full call pattern (Path B) | One LLM call per matchResume run → execution envelope (`step_results.*.rule_judgments[]` + `final_output`). Path A (per-rule parallel) and Path C (per-step batching) are documented backup paths in §14.1. |
| MVP confidence | LLM self-reported `[0, 1]` |
| Full confidence | Composite (logprobs + evidence count + consistency) |
| Storage MVP | Filesystem `data/simple-rule-check-runs/<YYYYMMDD>/<runId>.json` |
| Storage Full | Filesystem `data/rule-check-runs/<YYYYMMDD>/<runId>.json`. **Neo4j write-back is forbidden** — Rule Checker never writes DataObject instances into the Ontology API (incl. no `RuleCheckResult`). Any cross-run analytics layer must use an out-of-Ontology external store. |
| API MVP | `checkRule()` only |
| API Full | `checkRule()` + `checkRules()` (batch) |
| Domain policy | MVP defaults to `RAAS-v1`. The earlier TEST-RAAS-v1 isolation requirement has been dropped per user decision — audit traces are local-only so blast radius is limited to what `ONTOLOGY_API_BASE` points at. |
| First MVP rule | `10-7` (期望薪资) — minimum data plumbing, full loop demonstrated |
| MVP rule cohort | `10-7`, `10-17`, `10-18`, `10-25`, **`10-32`** — 10 seed candidates + 2 Application records |
| Cross-object MVP rule | `10-32` 岗位冷冻期 — forces `GET /api/v1/ontology/instances/Application?candidate_id=...&job_requisition_id=...`; LLM evidence must cite `Application.<id>.status` |
| Seed initialization | Required: graph has NO test data initially; `scripts/simple-rule-check-seed.ts` boots 4 DataObject schemas via verification + writes 14 instances (2 jobs + 10 candidates + 2 Application) to `RAAS-v1` |
| Ontology API coupling | Checker depends on **4 read-only** API capabilities (rule retrieval, schema introspection, single-instance read, filtered listing). Instance upsert is **seed-script only** and not part of the Checker's runtime dependency surface. Never talks bolt:// Neo4j directly. |
| LLM provider lock | OpenAI Chat Completions API + `response_format: json_schema` strict |
| Block-semantic check | Skipped in MVP, enabled in v1.1 with rule classification metadata |
| Validation failure handling | No retry. Force `pending_human`, persist run, record failure tags |
| UI MVP | `/dev/simple-rule-check` dev preview, mirroring `/dev/generate-prompt`'s shape |
| UI Full | Commercial product UI at `/rule-check/*`, integrated into app shell |
| Audit Q&A | Manual trace inspection in MVP; LLM-powered Q&A in full impl |
| Run detail page layout | **8 vertical layers** at `/rule-check/runs/[runId]`: (L1) Verdict hero, (L2) **Inference chain — new**, (L3) Why this verdict, (L4) Evidence ledger, (L5) **Counterfactuals — new**, (L6) Validation strip, (L7) Prompt + Response, (L8) Ask why. Locked: 2026-05-13. |
| Inference chain semantics | Three node classes: Rule (1) + Evidence cards (N from `decisive=true` evidence) + Verdict (1). Arrows are pure visual flow — **no edge labels** (audit JSON carries no relationship field). Cross-references between evidence are surfaced **inside fact cards only** (§9.3 D1), never as chain edges. Locked: 2026-05-13. |
| Fact card expansion | **Inline expansion** in the chain node's position (NOT a side-drawer). Multiple cards may be expanded simultaneously; the SVG chain re-flows vertically. Locked: 2026-05-13. |
| Matrix landing | `/rule-check` is a rules × candidates pass/fail grid. Cell color = latest run's `finalDecision.decision`. Cell click → run detail page. **Per-cell Replay button NOT offered** at matrix level (Replay is detail-page only). Locked: 2026-05-13. |
| Runs aggregate page | `/rule-check/runs` is **dashboard (top) / list (bottom-left) / preview (bottom-right)**. Single click on a list row updates preview only; preview's `[Open full detail →]` navigates. Default list sort: `timestamp` DESC. Locked: 2026-05-13. |
| Replay behavior | `[↻ Replay this case]` button on run detail Layer 1 → **new independent runId**. No in-place re-run, no automatic side-by-side diff in v1. Old run's audit JSON is never mutated. See §14.2. Locked: 2026-05-13. |
| UI derivations policy | UI MUST NOT generate new result content; MUST NOT invoke the LLM at render time (except the explicit Ask Why panel and explicit Replay action). All client-side derivations are enumerated exhaustively in §9.3 D1–D8. Each run is independent. Locked: 2026-05-13. |
| Aggregate at `/rule-check` (primary) / matrix at `/rule-check/matrix` (secondary) | Aggregate is the run-centric landing (run is the smallest unit); matrix is the rule × candidate visualization, explicitly the "matrix exception" allowed by §15. Route swap supersedes the prior "matrix-at-/rule-check" assignment. Locked: 2026-05-13. |
| `/rule-check/runs` → 308 redirect to `/rule-check` | Legacy URL stability; no content drift. Implemented via `next/navigation`'s `redirect()` server helper. Locked: 2026-05-13. |
| `/rule-check/rules` is a static rule dictionary | No firing rate / recent runs / per-rule run aggregation. Rule definitions only (`id` / `name` / `sourceText` / `canBlock` / `stepOrder`). Cross-run/per-rule analytics live in `/rule-check/audit`. Locked: 2026-05-13. |
| Aggregate preview expanded instances (D8) | Candidate main info card (key fields from Candidate or Resume instance) + collapsed list of remaining `fetched.instances`. Strict subset; no reformulation. Locked: 2026-05-13. |
| "Run new batch" action on Aggregate header | Opens `/dev/rule-check` engineering preview in a new tab. No inline form in v1. Locked: 2026-05-13. |
| JSON skeleton in prompt + `response_format` strict schema | Both retained; field-for-field cross-check confirms no conflict; P4 (skeleton removal) deferred per §6.4. Sync policy enforced by single-module residence + docstring lock. Locked: 2026-05-13. |
| **Path C — per-step sequential LLM calls (active runtime)** | Replaces Path B at runtime (2026-05-13). N LLM calls per matchResume run = one per `actionStep` with `rules.length > 0` (tool-only steps naturally skipped). Each call returns `{ rule_judgments[] }` using `StepResultJsonSchema` (sub-shape of `step_results.<step_N>`). Stages D-G of orchestrator restructured around a sequential per-step loop. `MatchResumeEvalEnvelopeZod` + `renderEnvelopeSkeleton` retained for `/dev/generate-prompt` only. Reason: kimi via new-api 504s on full-envelope ~10-15K-token output; per-step calls stay under proxy timeout. Locked: 2026-05-13. |
| Short-circuit trigger condition | `decision === "blocked" AND rule.canBlock !== false`. Covers blocker rules (`canBlock=true`) AND unclassified (`canBlock=undefined`); advisory rules (`canBlock=false`) do NOT short-circuit. When triggered, orchestrator skips LLM calls for subsequent steps and synthesizes `not_started` audit records for their rules. Locked: 2026-05-13. |
| `StepCallRecord[]` array audit shape | Per-step audit data stored as ordered array on `RuleCheckBatchRunAudited.stepCalls`. Skipped steps occupy array slots with `shortCircuited: true, llmRaw: null, promptProvenance: null`. Rationale: execution order is semantic; sparse skip representation explicit; consistent with project's array convention (results, evidence, ontologyApiTrace). Locked: 2026-05-13. |
| Deterministic `terminal` + `terminalAtStep` | `BatchAggregateDecision.terminal` derived deterministically by orchestrator (`true` ⟺ short-circuit fired). `terminalAtStep` is the `stepOrder` that triggered it. No LLM-claimed terminal; no cross-check warning. `aggregateDecisionLLMClaimed` field removed from `RuleCheckBatchRunAudited`. Locked: 2026-05-13. |
| Path C v1 drops `notifications` + `match_results` + `overall_status` | No LLM-emitted `final_output` in per-step calls, so `notifications` is empty in Path C v1. step 4 (`generateMatchResult` tool-only) is skipped (0 rules → not iterated). Revisit when rule classifier provides `notificationTemplate` metadata, or when a dedicated post-LLM deterministic synthesizer for step-4 outputs is added. Locked: 2026-05-13. |
| Synthesized `not_started` for skipped step's rules | Code generates per-rule audit records with `decision: "not_started"`, `finalDecision.overrideReason: "short_circuit:step_<N>:rule_<id>"`, `validation.failures: ["short_circuit_by_step_<N>_rule_<id>"]`. Keeps matrix / aggregate complete. UI distinguishes via `↯ Skipped (short-circuit)` badge (on Run detail Layer 1) and short-circuit chip in Aggregate preview header. Locked: 2026-05-13. |
| Code-side responsibility boundary (Path C) | LLM is the sole judge of per-rule `decision`. Code performs (a) cascade aggregate, (b) flow-control short-circuit, (c) safety-net `pending_human` override on validation failure (`computeFinalDecision` — unchanged from MVP), (d) synthesized markers for skipped rules. Code does NOT compute `blocked` / `passed` from data; code only routes / overrides / aggregates. Locked: 2026-05-13. |
| **"运行 = batch" UI semantic (v3)** | `/rule-check` rows are 1-per-batch (was 1-per-rule); new `/rule-check/batches/[batchId]` page renders single-run detail (verdict + stepCalls + candidate/job overview + step-grouped rule cards with `规则原文` + 3-section judgment basis). Per-rule Prove page at `/rule-check/runs/[runId]` preserved as deeper drill-down. Operator's mental "运行" = code's `batch`; per-rule check is "判定". Locked: 2026-05-13. |
| **`ruleRequirement` / 【规则要求】 fully removed** | Removed from prompt template (`renderConstraints` / `renderBeforeReturn`), JSON schema (`RootCauseSectionsZod` + `RootCauseSectionsJsonSchema`), TypeScript types (`RootCauseSections`), in-prompt skeleton (`renderStepResultSkeleton`), UI (`RootCauseTimeline` band drop + dev/rule-check row drop + mock fixtures). Going forward: `rootCauseSections` has 3 keys (`dataObservation` / `contrastReasoning` / `conclusion`). Rule's original text is shown on the batch detail page where the operator can read it once; reproducing it inside every judgment was redundant. MVP `lib/simple-rule-check/` excluded (frozen module — its `extractor.ts` keeps 4-section structure as an intentional divergence). Locked: 2026-05-13. |
| **Validation fully demoted to informational-only (v3.1)** | Supersedes the v3 "Q4 lenient `evidenceGrounded`" row. `computeFinalDecision` only overrides on `parsed === null` (LLM output failed Zod schema → no decision exists; `pending_human` is the only sensible fallback). All other validation results — `ruleIdExists` / `schemaValid` per-field failures / `blockSemanticCheck === "warning"` / `evidenceGrounded` — write to `validation.failures[]` for audit traceability but do NOT override LLM decision. UI L6 ValidationLight strip continues to render per-flag values. Rationale: code does not replace LLM as the rule judge; validation is an observational signal, not decisional authority. Locked: 2026-05-13. |
| **FactCard hydration fix (v3.1)** | Outer wrapper changed from `<button>` to `<div role="button" tabIndex={0} onKeyDown={...}>` because expanded body contains `<a>` (Neo4j Browser) + `<button>` (Copy Cypher); HTML forbids nested interactive elements (React 19 / Next 16 surface as hydration error). ARIA `aria-expanded` semantic + keyboard activation (Enter / Space with `preventDefault`) preserved manually; internal `stopPropagation` on inner `<a>` / `<button>` (FactCard.tsx:368 / 384) continues to block outer toggle bubble. Locked: 2026-05-13. |
| **`/rule-check/runs/[runId]` page-level scrolling (v3.1)** | Outer wrapper in `RunDetailContent` gains `flex flex-col h-full min-h-0 overflow-y-auto`; inner `max-w-[1100px] mx-auto w-full` preserved (centering invariant). Chrome-only change; 8-layer structure / atoms / interactions invariant. Locked: 2026-05-13. |
| **Candidate / job overview enrichment (v3.1)** | `collectCandidateFields` adds 居住地 / 工作年限 (prefer `total_years_experience` else compute from `work_experience[]` month diffs via new `computeYearsOfExperience` helper) / 当前在职 (when latest entry's `end_date` missing or "present"/"至今"/"now") / 求职意向 / 期望薪资. `collectJobFields` adds 类别 (priority chain: `category` / `job_category` / `function` / `job_family` / `level`) / 工作地点 / 雇佣类型 / 业务线 / 招聘人数. Picker contract unchanged ("emit only fields that exist"). New `parseYearMonth` helper accepts `YYYY-MM`, `YYYY/MM`, `YYYY-MM-DD` forms; returns null for unparseable input or "present"/"至今"/"now". Locked: 2026-05-13. |
| **`/rule-check/runs/[runId]` invariant** | 8-layer Prove page (RunDetailContent + 10 atoms: DecisionBadge / InferenceChain / FactCard / CounterfactualsList / ReplayButton / MatrixGrid / ConfidenceRing / EvidenceCard / ValidationLight / AskWhyChat / RootCauseTimeline) structure / layers / interactions preserved invariantly. Only `RootCauseTimeline` drops one band (from 4 → 3 segments) as a consequence of the global `ruleRequirement` removal. No new sections (no rule sourceText card, no candidate/job overview cards added here — those live on `/rule-check/batches/[batchId]` instead). Locked: 2026-05-13. |
| **Scrolling unified** | `flex flex-col h-full min-h-0 + overflow-y-auto` pattern applied to `/rule-check/matrix`; `/rule-check/rules` already had it; `/rule-check` already had it; `/dev/rule-check` uses native `min-h-screen` browser-level scroll. Locked: 2026-05-13. |

---

## 16. Pre-plan thinking — for full `rule-check` impl

Notes to drive the next PLAN MODE session. These are working assumptions, not locked decisions.

### 16.1 The shape of the work

Full impl is **not** "MVP + more rules". It is a different architecture:

| Axis | MVP (`simple-rule-check`) | Full (`rule-check`) |
|---|---|---|
| Prompt source | Hand-built `extractor.ts` | **Verbatim consumption of `generatePrompt` output** + thin focusing system message. `generatePrompt`'s template itself is rewritten so its output schema embeds rule_judgments — no section discarding required. |
| Call topology | 1 rule → 1 LLM call | **Path B locked**: 1 LLM call per run → execution envelope (`step_results.*.rule_judgments[]` + `final_output`). Path A (per-rule parallel) and Path C (per-step batching) are reserved backup paths (§14.1). |
| Aggregation | N/A | Two-tier: LLM emits its `final_output.aggregateDecision`; orchestrator re-derives deterministically from `rule_judgments[]` and uses the deterministic value as source of truth (LLM-claimed value preserved for audit cross-check). |
| Output | Plain `RuleJudgment` | `RuleJudgmentAudited` (§6.3) embedded in execution envelope; per-run audit metadata (provenance + ontologyApiTrace) wraps the envelope. |
| Storage | Filesystem only | Filesystem + out-of-Ontology external store (TBD) |
| Surfaces | CLI + dev UI | CLI + dev UI + **commercial product UI** at `/rule-check/*` |
| Coupling | Standalone | **Coupled upstream to `generatePrompt`** (verbatim consumption, template rewrite shared); **downstream contract shared with matchResume executor agent** (same envelope, different post-processing). |

### 16.2 Dependency order (what blocks what)

```
[A] Schema work (Ontology repo, external)
    ├── (a1) Add can_block + required_instances to Rule node
    └── (a2) [optional] Add RuleCheckResult-like audit nodes — NO, forbidden per §2
              (use external store instead — pick OpenSearch | ClickHouse | filesystem index)
                              │
[B] Module skeleton (lib/rule-check/)
    ├── (b1) types-audited.ts + RuleJudgmentAudited / RuleCheckRunAudited
    ├── (b2) prompt/full-action.ts  — consumes generatePrompt → produces eval prompt
    ├── (b3) orchestrator/all-in-one.ts  — one LLM call, all rules
    ├── (b4) confidence/composite.ts  — needs logprobs (validate provider supports)
    ├── (b5) validation/block-semantic.ts  — needs (a1)
    ├── (b6) checker.ts  — checkRules() actual impl
    └── (b7) store/external.ts  — pick + implement external store
                              │
[C] CLI + dev preview (scripts/rule-check.ts, /dev/rule-check)
                              │
[D] Commercial UI (/rule-check/*) — depends on (B) for audit-rich payload
    ├── (d1) Run detail page  — Layer 1-6 panels
    ├── (d2) Run list + filters
    ├── (d3) Diff view  — needs (B) promptProvenance
    ├── (d4) Ask-why panel  — needs (B) askWhyHistory schema + LLM call wiring
    ├── (d5) Dashboard
    ├── (d6) Compliance / audit pages
    └── (d7) Settings
                              │
[E] matchResume agent integration — separate work, but Full impl unlocks it
```

Bottleneck: **(A) — ontology schema work**. Block-semantic validation can't ship until rule classification metadata exists. Workaround during dev: hard-code a `rule_classification.json` in `lib/rule-check/` and migrate to ontology-driven once (a1) lands.

### 16.3 Risks worth flagging in plan

| Risk | Why it bites | Mitigation candidate |
|---|---|---|
| **Path B single-envelope output too large** | matchResume has 10+ rules × (rootCause + rootCauseSections×4 + evidence[] + counterfactuals) per judgment → ~5000+ output tokens. Some providers (Kimi-k2.6 / new-api) 504 before completing this output volume. **Empirically observed 2026-05-12: kimi-k2.6 took >15min and 504'd on the original BatchJudgments shape.** | (1) Validate Path B against a provider with sufficient output throughput (gpt-4o / Claude). (2) Be prepared to invoke §14.1 Path A backup if production provider can't sustain. (3) Trim audit fields (drop counterfactuals temporarily; merge rootCauseSections into prose) only as last resort — would weaken Prove UI. |
| Single envelope all-or-nothing failure | A single malformed character in the envelope → `BatchJudgments.safeParse` fails → all rules cascade to `pending_human`. | Per-judgment fallback INSIDE the envelope (only the malformed `rule_judgments[i]` falls back). Soft-warning if `final_output.aggregateDecision` disagrees with deterministic re-derivation. See §11. |
| `generatePrompt` template rewrite breaks matchResume executor agent | The Inngest worker reads the executor envelope; changing schema is a breaking change. | Coordinate rollout: ship template change behind a feature flag or version field (`schemaVersion: "v4-eval"`) so executor agent can adopt at its own pace. Document in `docs/GENERATE-PROMPT-USER-GUIDE.md` once decided. |
| `logprobs: true` unsupported by current LLM provider | Composite confidence needs it. Kimi-k2.6 has historically been unstable — request with `logprobs: true` sometimes hangs the provider. | (1) Disable logprobs by default in `lib/rule-check/llm-client.ts`; opt-in via `RULE_CHECK_LOGPROBS=1` env. (2) Confidence calculator handles graceful degradation: if no logprobs, drop to `0.5 × evidenceCount + 0.5 × consistency`. |
| `generatePrompt` output not stable across calls (random ordering, timestamps) | promptProvenance.promptSha256 changes spuriously, breaks drift detection. | Already mitigated: hash `stripCurrentTimeBlock(prompt)` to skip the `## 当前时间` block. |
| Counterfactual hallucination | LLM-proposed counterfactuals could be wrong about what flips a verdict. | Don't trust them — UI labels them "speculative". Optionally run them through the actual Checker as a verification step (expensive). |
| External store choice paralysis | OpenSearch / ClickHouse / filesystem index / S3 — all viable, all wrong for some workload. | MVP-of-Full ships with filesystem-index (no infra). Migration path documented. |
| MVP / Full divergence | `simple-rule-check` could rot. | Decide explicitly: MVP accepts security/schema-drift fixes only, no feature work. Document in CLAUDE.md. |

### 16.4 Reuse map (verified against current code)

Already shipped, reuse as-is:
- `lib/ontology-gen/client.ts` — HTTP layer (`getJson` / `postJson`)
- `lib/ontology-gen/errors.ts` — error hierarchy
- `lib/ontology-gen/fetch.ts:fetchAction` — rule retrieval
- `lib/ontology-gen/v4/generate-prompt.ts:generatePrompt` — **the canonical entry point `rule-check` calls to get the prompt source** (verbatim; see §7.2.full)
- `lib/ontology-gen/v4/fill-runtime-input.ts:fillRuntimeInput` — runtime input substitution after `generatePrompt` returns templated form
- `lib/ontology-gen/v4/runtime-adapters/match-resume.ts:MatchResumeRuntimeInput` — runtime input shape for matchResume
- `lib/simple-rule-check/types.ts:Evidence, ValidationReport, RuleDecision, ...` — base types Full impl re-exports / extends
- `lib/simple-rule-check/rule-instance-map.ts:instancesNeededForRule` — **sibling-copy into `lib/rule-check/`** (含义 A1, locked decision 2026-05-12; per-module evolution allowed)
- `lib/simple-rule-check/fetch-instances.ts` — sibling reference for `lib/rule-check/fetch-instances.ts` (with traced HTTP layer)
- `components/shared/atoms.tsx` — UI atoms (`Badge`, `StatusDot`, `Card`, `CardHead`, `Metric`, `Spark`, `Btn`)
- `app/globals.css` — OKLCH tokens, dark mode

**To-be-modified** (Full impl scope, breaking change coordinated with matchResume executor agent):
- `lib/ontology-gen/v4/assemble-v4-4.ts` — rewrite `renderFinalOutputSchema` / `renderConstraints` / `renderBeforeReturn` / `renderFinalConsolidation` to emit the execution envelope per §6.3
- `lib/ontology-gen/v4/types.ts` — extend `ActionObjectV4` only if envelope versioning is added (`schemaVersion: "v4-eval"`)

To-be-built atoms for the Prove UI (per §9.2 footer):
- `EvidenceCard` (with provenance link + grounded indicator)
- `PromptPanel` (3-tab: resolved / source actionObject / diff)
- `LogprobInlineChart` (only renders when logprobs available)
- `RootCauseTimeline` (4-section colored band layout)
- `DecisionBadge` (4-value styling)
- `ValidationLight` (4-cell)
- `RunDiffView`
- `AskWhyChat`

### 16.5 Open design questions for PLAN MODE

1. **External store pick** — OpenSearch (good for analytics + full-text search) vs ClickHouse (cheaper, better for time-series) vs plain filesystem index (zero-infra, MVP-friendly). Recommendation: start with filesystem index, design store interface so swap is later.

2. **Where does matchResume agent live?** — `lib/match-resume/` (new dir)? Or is it the orchestrator that calls into `lib/rule-check/` and lives… outside this repo (e.g., a worker process)?

3. **"Resolved prompt" capture timing** — capture once at prompt-build (cheap) vs allow re-fetching from `generatePrompt` for the diff view (more accurate but slower). Recommendation: capture once + store; diff view re-invokes `generatePrompt` lazily on user request.

4. **logprob fallback** — does dev want hard-fail (refuse to ship if provider doesn't support) or graceful degradation? Implies LLM client probe at startup.

5. **UI build order** — bottom-up (atoms → run detail → list → dashboard) vs top-down (dashboard skeleton → fill in)? My take: bottom-up. Run detail page is the highest-value standalone view; rest depend on its components.

6. **Rule classification metadata bootstrap path** — push ontology repo to extend Rule schema is the locked decision, but timeline is uncertain. While waiting, do we ship a temp local `rule_classification.json`?

7. **Re-run + diff** — does "re-run" persist as a new run with the original-runId linked, or as a sub-record of the original? My take: new run with `priorRunId` field; preserves linear timeline.
