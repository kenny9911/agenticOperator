# `generatePrompt` — User Guide (v4)

This guide covers the **canonical v4 prompt-generation surface**. Two audiences:

- **Consumer** (Part I) — you want to import the snapshot or call `generatePrompt` to substitute runtime data into the prompt.
- **Maintainer** (Part II) — you own this codegen, need to regenerate snapshots, add a new action, or change the public types.

The lib is **action-extensible**: a registry of `ActionRuntimeAdapter`s tells core (`generatePrompt` / `fillRuntimeInput`) how to handle each action's sentinel + placeholder substitution. Today only `matchResume` is registered; new actions plug in via a single adapter file + one `registerAdapter()` call.

---

# Part I — Consumer

## At a glance

| Mode | Function | Imports | When to use |
|---|---|---|---|
| **A. Snapshot import + fill** | `fillRuntimeInput(obj, input, scope)` | `generated/v4/match-resume.action-object` + `lib/ontology-gen/v4` | Zero-fetch, deterministic. **Default for production.** |
| **B. Runtime resolve** | `generatePrompt({ actionRef, client, clientDepartment?, domain?, runtimeInput? })` | `lib/ontology-gen/v4` | Live prompt against the current Ontology API; picks up rule changes since the snapshot. |

Both modes return the same `ActionObjectV4` shape:

```ts
interface ActionObjectV4 {
  prompt: string;            // markdown, ready to feed an LLM as a user message
  meta: ActionObjectMetaV4;  // actionId / actionName / domain / compiledAt / templateVersion / promptStrategy / validation
}
```

Tenant `scope` (client + optional department) is **not** part of the runtime input — it flows in as a separate parameter on both APIs. `client` is **required**: it drives rule filtering AND renders the `### client` block. `department` is optional and adds a `department:` line.

## Mode A — snapshot import + fill (recommended)

1. **Import** the static snapshot (committed to `generated/v4/`):

   ```ts
   import { matchResumeActionObject } from "@/generated/v4/match-resume.action-object";
   import { fillRuntimeInput } from "@/lib/ontology-gen/v4";
   import type {
     MatchResumeRuntimeInput,
     RuntimeScope,
   } from "@/generated/v4/action-object-v4.types";
   ```

2. **Build** a typed `MatchResumeRuntimeInput` and a `RuntimeScope`:

   ```ts
   const input: MatchResumeRuntimeInput = {
     job: {
       job_requisition_id: "JR-2026-001",
       title: "高级后端工程师",
       required_skills: ["Java", "Spring Boot", "MySQL"],
       // ... any other fields the live Job_Requisition carries; all pass through verbatim
     },
     resume: {
       candidate_id: "C-12345",
       name: "Alice",
       work_experience: [/* ... */],
       // ... any other fields the live Resume carries
     },
   };

   const scope: RuntimeScope = {
     client: "腾讯",                      // → rendered as `client_name: 腾讯`
     department: "互动娱乐事业群",          // → rendered as `department: 互动娱乐事业群`
   };
   ```

3. **Fill** and send:

   ```ts
   const ready = fillRuntimeInput(matchResumeActionObject, input, scope);
   const response = await llm.complete({
     messages: [{ role: "user", content: ready.prompt }],
   });
   ```

## Mode B — runtime resolve

When the prompt needs to reflect the **latest** rules from the live Ontology API (not the committed snapshot):

```ts
import { generatePrompt } from "@/lib/ontology-gen/v4";

const obj = await generatePrompt({
  actionRef: "matchResume",
  client: "腾讯",                       // required
  clientDepartment: "互动娱乐事业群",     // optional
  domain: "RAAS-v1",
  runtimeInput: {
    job:    { job_requisition_id: "JR-2026-001", /* ... */ },
    resume: { candidate_id: "C-12345", /* ... */ },
  },
  // env reads:
  //   ONTOLOGY_API_BASE   (or pass apiBase)
  //   ONTOLOGY_API_TOKEN  (or pass apiToken)
});

await llm.complete({ messages: [{ role: "user", content: obj.prompt }] });
```

Without `runtimeInput`, the returned `prompt` retains the placeholders — useful when you want to fetch once and fill with multiple candidates later. `{{CURRENT_TIME}}` is substituted only at fill time.

### Advanced `generatePrompt` options

Beyond the core fields, `GeneratePromptOptions` exposes three optional knobs:

| Option | Type | Effect |
|---|---|---|
| `extraInstances` | `Record<string, Record<string, unknown>[]>` | Adds a `## 额外数据 (按 rule 依赖预取)` section between `## 运行时输入` and `## 最终输出 JSON 结构`. Keyed by entity label (e.g. `"Candidate_Expectation"`), value is the list of fetched instance objects. Each entry is rendered as a fenced ```` ```json ```` block. Indexing convention: `fetchedInstanceIndex` 0 = Job, 1 = Resume, 2..N = extras in insertion order. |
| `focusStep` | `string` | Path-C single-step mode. The assembler renders **only** the named action step's rule cluster + a slim per-step envelope (`StepResultJsonSchema`), suppressing the batch-level `final_output { ... }` block. Used by `lib/rule-check`'s orchestrator for one-LLM-call-per-step execution. |
| `timeoutMs` | `number` | Forwarded to `fetchAction` and `fillRuntimeInput`. Default: provider-dependent (no explicit cap). |

`domain` defaults to `"RAAS-v1"` if omitted.

## The runtime input contract

`MatchResumeRuntimeInput` (full shape in `generated/v4/action-object-v4.types.ts`):

| Field | Type | Notes |
|---|---|---|
| `job.job_requisition_id` | `string` | Only hard-required Job field; everything else is property-bag. |
| `resume.candidate_id` | `string` | Only hard-required Resume field; everything else is property-bag. |

Tenant scope is passed separately (NOT inside `runtimeInput`):

| Param | Type | Notes |
|---|---|---|
| `client` | `string` (**required**) | Drives `applyClientFilter` AND renders as `client_name: <name>` in the CLIENT block. |
| `clientDepartment` (Mode B) / `scope.department` (Mode A) | `string?` | When present, adds `department: <department>` line. Filter-side support is reserved but currently a no-op. |

Universal placeholder — substituted automatically by `fillRuntimeInput`:

| Placeholder | Substitution | Notes |
|---|---|---|
| `{{CURRENT_TIME}}` | Current Beijing time, ISO-8601 | Format: `2026-05-11T14:30:00+08:00 (Asia/Shanghai)`. Fresh per fill — useful for rules involving age / dates. |

**Why so few required fields?** Upstream `Job_Requisition` and `Resume` DataObjects are schema-agnostic property-bags and evolve frequently. TS-locking every field would create constant friction. The renderer JSON-stringifies the entire job / resume object verbatim into the prompt — the LLM reads whatever fields are present.

**Casing**: TS field names are camelCase (e.g. `client`); the renderer maps to the prompt's snake_case format (`client_name:`).

## Caveats

1. **`{{...}}` literals inside your input are safe.** The substitution is single-scan: each position in the template is matched at most once. A `{{JOB}}` substring that happens to appear inside your `resume` value will *not* be re-substituted.

2. **`fillRuntimeInput` requires `scope`.** Passing only `(obj, input)` is a type error — `client` must always be supplied. There is no implicit fallback.

3. **`{{CURRENT_TIME}}` is re-filled on every `fillRuntimeInput` call.** Two consecutive fills of the same snapshot will produce prompts that differ in the `## 当前时间` line. If you need a frozen time, capture the rendered prompt or substitute the placeholder yourself before calling fill.

4. **`meta.compiledAt` is frozen at snapshot generation time.** `fillRuntimeInput` does **not** update it. Mode B's `compiledAt` reflects the current call time.

5. **`fillRuntimeInput` is synchronous.** Returns a new object; never mutates the input snapshot. The only impurity is `new Date()` for `{{CURRENT_TIME}}`.

6. **The snapshot lives under `generated/v4/`.** v3 snapshots (full Action mirror) live in a separate codegen commit under `generated/v3/`; don't mix imports across versions.

## Generic / advanced runtime input

`fillRuntimeInput` also accepts inputs that no registered adapter recognizes. Dispatch is by `obj.meta.actionId / actionName` (not by input shape) — if no adapter matches the action, the fallback path engages:

- **`string`** — substituted verbatim into the single `{{RUNTIME_INPUT}}` placeholder.
- **`Record<string, unknown>`** — JSON-stringified into a ` ```json ``` ` block, then substituted into `{{RUNTIME_INPUT}}`.

`{{CURRENT_TIME}}` is still substituted in both fallback paths. `scope` is unused by the fallback (only the matchResume adapter renders `{{CLIENT}}`), but the arg is still required for type-uniformity.

## Dev preview — `/dev/generate-prompt`

`npm run dev`, then visit `http://localhost:3002/dev/generate-prompt`. The page is **action-agnostic**:

- Enter an `actionRef` + `domain`, `client` (required) + `clientDepartment` (optional).
- Paste a complete runtime-input JSON in the single textarea (no `client` / `department` keys — those go in the param row).
- Click **Run live** — the server action calls `generatePrompt`, the response renders on the right.

To exercise a new action: register its adapter in `lib/ontology-gen/v4/runtime-adapters/index.ts`, then change `actionRef` + paste the matching JSON. No UI change required.

---

# Part II — Maintainer

## Architecture overview

```
                   ┌──────────────────────────────────────────────┐
                   │ Ontology API (Studio, port 3500)             │
                   │   GET /api/v1/ontology/actions/{ref}/rules   │
                   └────────────────────┬─────────────────────────┘
                                        │
                          ┌─────────────▼──────────────┐
                          │  lib/ontology-gen/fetch.ts  │ ← Action shape + invariants
                          └─────────────┬───────────────┘
                                        │ Action
                                        ▼
            ┌────────────────────────────────────────────────────┐
            │  lib/ontology-gen/v4/generate-prompt.ts             │
            │    (canonical entry — async)                        │
            │                                                     │
            │   1. findAdapterByAction(action) → sentinel         │
            │      (fallback RUNTIME_INPUT_PLACEHOLDER)            │
            │   2. assembleActionObjectV4_4({ runtimeInput        │
            │      = sentinel, client })                          │
            │   3. If runtimeInput given → fillRuntimeInput       │
            │      with { client, department } as scope           │
            └───────────────┬─────────────────────────────────────┘
                            │
                            ▼ ActionObjectV4
                ┌─────────────────────────────────┐
                │  fill-runtime-input.ts          │ sync
                │   findAdapterByAction(obj.meta) │
                │   → adapter.buildSubstitutions  │
                │     (input, scope)              │
                │   + {{CURRENT_TIME}} injected   │
                │   → substitute() (single scan)  │
                └─────────────────────────────────┘
```

The trick: `assembleActionObjectV4_4` accepts `runtimeInput: string` and splices it verbatim under the `## 运行时输入` heading. Each adapter provides its own sentinel (a string containing sub-headers + `{{...}}` placeholders). The assembler emits a `## 当前时间\n\n{{CURRENT_TIME}}` section between `## 任务` and `## 运行时输入`; this placeholder is replaced at fill time so each render carries a fresh Beijing-time stamp.

Dispatch in `fillRuntimeInput` is by action identity (`obj.meta.actionId / actionName`), not by input shape — there is no `kind` discriminator on `runtimeInput`.

## Module layout

```
lib/ontology-gen/
├── client.ts                         # HTTP helper
├── errors.ts                         # OntologyGenError hierarchy
├── fetch.ts                          # fetchAction (Ontology API → typed Action)
├── validate.ts                       # invariant assertions
├── types.public.ts / types.internal.ts
├── compile/filter.ts                 # applyClientFilter (used by v4-4)
├── index.ts                          # slim re-exports (errors, fetch, types)
└── v4/
    ├── assemble.ts                   # v4-1/2/3 alternative assembler + re-exports RUNTIME_INPUT_PLACEHOLDER / CURRENT_TIME_PLACEHOLDER
    ├── assemble-v4-4.ts              # v4-4 canonical prompt assembler; accepts string sentinel; renders `## 额外数据` from extraInstances; per-step "focusStep" Path C mode
    ├── envelope-schema.ts            # final-output JSON skeleton + per-step skeleton renderers; MatchResumeEvalEnvelopeZod / StepResultZod
    ├── types.ts                      # ActionObjectV4 / Meta / EnrichedAction
    ├── fill-runtime-input.ts         # core sync filler; dispatches via registry by meta
    ├── generate-prompt.ts            # canonical async entry; sentinel via registry
    ├── index.ts                      # public re-exports
    ├── placeholders.ts               # SHIM → runtime-adapters/match-resume (preserved for deep imports)
    ├── runtime-input.types.ts        # SHIM → runtime-adapters/match-resume + types
    └── runtime-adapters/
        ├── types.ts                  # ActionRuntimeAdapter<T> + RuntimeInputV4 + RuntimeScope
        ├── registry.ts               # adapters[] + register/findByAction/list
        ├── substitute.ts             # single-scan placeholder regex replace
        ├── utils.ts                  # renderJsonBlock + formatBeijingTimeISO
        ├── match-resume.ts           # matchResume types / placeholders / sentinel / adapter
        └── index.ts                  # barrel + registerAdapter(matchResumeAdapter)

generated/
└── v4/
    ├── action-object-v4.types.ts     # consumer ABI (hand-written subset of v4 types)
    └── match-resume.action-object.ts # codegen'd snapshot

scripts/
├── gen-v4-snapshot.ts                # CLI: fetch → assemble (with sentinel) → emit
└── fill-result-prompts.ts            # one-shot: render test cases into result.md

app/dev/generate-prompt/
├── page.tsx                          # interactive preview (live-only, single JSON input)
└── actions.ts                        # server action for live mode

docs/
└── GENERATE-PROMPT-USER-GUIDE.md     # this file
```

The wider codegen system (v3 pipeline, v4-1/2/3 strategy router, legacy preview at `/dev/action-preview`, and their generated snapshots) lives in separate commits.

## Regenerating the matchResume snapshot

```bash
# Set in .env.local:
#   ONTOLOGY_API_BASE=http://localhost:3500
#   ONTOLOGY_API_TOKEN=<bearer token>

npm run gen:v4-snapshot -- --action matchResume --domain RAAS-v1
```

Produces `generated/v4/match-resume.action-object.ts`. The script:

1. `fetchAction` against `/api/v1/ontology/actions/matchResume/rules?domain=RAAS-v1`.
2. Picks `MATCH_RESUME_HIERARCHY_SENTINEL` via `findAdapterByAction` (the matchResume adapter supplies it).
3. `assembleActionObjectV4_4({ runtimeInput: sentinel })` — the prompt contains:
   - `## 当前时间\n\n{{CURRENT_TIME}}` (universal placeholder)
   - `## 运行时输入\n\n### client\n\n{{CLIENT}}\n\n### 招聘岗位 (Job_Requisition)\n\n{{JOB}}\n\n### 候选人简历 (Resume)\n\n{{RESUME}}`
4. Emits a TS module with banner + named export + default export.

The snapshot is generated **without** a client filter, so all rules (universal + tenant-specific) are baked in. Per-client filtering happens at runtime via `applyClientFilter` (in `assembleActionObjectV4_4`) when going through `generatePrompt`. If you need a per-client snapshot, extend the script with a `--client` flag and re-run.

**Diff hygiene**: `meta.compiledAt` advances on every run. If that's the only diff, the regen was a no-op.

## Maintainer checklist — when public ABI changes

Whenever you touch the **public surface** of `ActionObjectV4` / `ActionObjectMetaV4` / runtime-input types / `RuntimeScope` (or related types):

1. Edit the canonical source:
   - `lib/ontology-gen/v4/types.ts` for ActionObject / Meta shapes
   - `lib/ontology-gen/v4/runtime-adapters/match-resume.ts` for matchResume runtime types
   - `lib/ontology-gen/v4/runtime-adapters/types.ts` for the adapter contract / `RuntimeInputV4` / `RuntimeScope`
2. **Mirror the change** in `generated/v4/action-object-v4.types.ts` (consumer ABI — hand-written subset). The two files MUST agree on the shape; TS will surface drift via the snapshot's import.
3. The `templateVersion` field is the literal `"v4"` — do not change it for content-only changes. Bump the literal only when the prompt **structure** changes in a breaking way.
4. Re-run `npm run gen:v4-snapshot -- --action matchResume --domain RAAS-v1`.
5. `npm run build` — typecheck catches drift.

## Adding a new action

The adapter registry makes this a 3-step operation. Example: adding `screenCandidate`.

1. **Write the adapter file** — `lib/ontology-gen/v4/runtime-adapters/screen-candidate.ts`:

   ```ts
   import type { ActionRuntimeAdapter, RuntimeScope } from "./types";
   import { renderJsonBlock } from "./utils";

   export interface ScreenCandidateRuntimeInput {
     interviewPlan: Record<string, unknown>;
   }

   export const PLACEHOLDER_INTERVIEW_PLAN = "{{INTERVIEW_PLAN}}";

   export const SCREEN_CANDIDATE_SENTINEL = [
     "### client", "", "{{CLIENT}}", "",
     "### 面试方案 (InterviewPlan)", "", PLACEHOLDER_INTERVIEW_PLAN,
   ].join("\n");

   function renderClient(scope: RuntimeScope): string {
     const lines = [`client_name: ${scope.client}`];
     if (scope.department) lines.push(`department: ${scope.department}`);
     return lines.join("\n");
   }

   export const screenCandidateAdapter: ActionRuntimeAdapter<ScreenCandidateRuntimeInput> = {
     matches: (action) => action.name === "screenCandidate",
     sentinel: SCREEN_CANDIDATE_SENTINEL,
     buildSubstitutions: (input, scope) => ({
       "{{CLIENT}}": renderClient(scope),
       [PLACEHOLDER_INTERVIEW_PLAN]: renderJsonBlock(input.interviewPlan),
     }),
   };
   ```

2. **Register it** — append to `lib/ontology-gen/v4/runtime-adapters/index.ts`:

   ```ts
   import { screenCandidateAdapter } from "./screen-candidate";
   registerAdapter(screenCandidateAdapter);
   ```

   Re-export the input type from the same barrel + from `lib/ontology-gen/v4/index.ts` (recommended) so consumers can `import type { ScreenCandidateRuntimeInput } from "@/lib/ontology-gen/v4"` without reaching into adapter modules.

3. **Generate the snapshot** (if you want a committed snapshot):

   ```bash
   npm run gen:v4-snapshot -- --action screenCandidate --domain RAAS-v1
   ```

   The codegen script picks the sentinel via `findAdapterByAction`, so it works automatically once the adapter is registered.

That's it. `generatePrompt` and `fillRuntimeInput` route to the new adapter via registry lookup; no edits to core files. To verify, visit `/dev/generate-prompt`, set `actionRef=screenCandidate`, paste a matching JSON, click Run live.

## Files reused (do not modify, except as documented)

- `lib/ontology-gen/v4/assemble-v4-4.ts` — the v4-4 assembler is treated as immutable, with the **documented exception** of the `## 当前时间` section (added between `## 任务` and `## 运行时输入`, purely additive). Don't add further logic here unless extending the exception is justified.
- `lib/ontology-gen/v4/assemble.ts` — placeholder constants (`RUNTIME_INPUT_PLACEHOLDER`, `CURRENT_TIME_PLACEHOLDER`).
- `lib/ontology-gen/fetch.ts` — fetch + invariant assertions; shared with the broader codegen.

## Known caveats

- **`isMatchResumeAction` duplication**: `runtime-adapters/match-resume.ts:isMatchResumeAction` mirrors the assembler-internal check (`id === "10" || name === "matchResume"`). Drift risk low but sync both sites if changed.
- **Snapshot vs runtime semantics**: snapshot's `meta.compiledAt` is the codegen time; the prompt body is otherwise deterministic up to `{{CURRENT_TIME}}` (which is *always* re-filled by `fillRuntimeInput`). Real prompt-body diffs across regens (outside `meta.compiledAt`) signal an upstream rule change worth investigating.
- **`{{CURRENT_TIME}}` re-fills every call**: a single snapshot rendered twice in 5 seconds will yield prompts that differ in the `## 当前时间` line. If you need a frozen time for caching / hashing, post-process the rendered prompt.
- **Substitution safety**: `substitute()` is single-scan, so adversarial input *cannot* re-trigger another placeholder. If you ever need stricter handling (e.g. escape sequences, length caps), wrap input sanitization at the call site.
- **Adapter registration timing**: `runtime-adapters/index.ts` registers adapters as a top-level side effect. `fill-runtime-input.ts` and `generate-prompt.ts` both import the barrel to guarantee registration runs before any lookup.
- **Build coverage**: `npm run build` runs `tsc --noEmit` + lint across the entire repo. Any drift between `lib/ontology-gen/v4/types.ts` and `generated/v4/action-object-v4.types.ts` surfaces as a type error in `generated/v4/match-resume.action-object.ts`.
- **TS narrowing loss for `RuntimeInputV4`**: dropping the old `kind` discriminator means the open `RuntimeInputV4` union no longer narrows across actions. Import action-specific types directly (`MatchResumeRuntimeInput`) when you want type-checked construction.

## Quick verification

```bash
# Regenerate snapshot (optional, only if upstream rules changed)
npm run gen:v4-snapshot -- --action matchResume --domain RAAS-v1

# Eyeball the placeholders
grep -E '\{\{CLIENT\}\}|\{\{JOB\}\}|\{\{RESUME\}\}|\{\{CURRENT_TIME\}\}' generated/v4/match-resume.action-object.ts
grep -E '### client|### 招聘岗位|### 候选人简历|## 当前时间' generated/v4/match-resume.action-object.ts

# Typecheck end-to-end
npm run build

# Live preview
npm run dev
# → http://localhost:3002/dev/generate-prompt
```

A successful round-trip:

```ts
// scratch file (do not commit)
import { matchResumeActionObject } from "@/generated/v4/match-resume.action-object";
import { fillRuntimeInput } from "@/lib/ontology-gen/v4";

const ready = fillRuntimeInput(
  matchResumeActionObject,
  {
    job:    { job_requisition_id: "JR-001", title: "test" },
    resume: { candidate_id: "C-1", name: "Alice" },
  },
  { client: "腾讯", department: "互动娱乐事业群" },
);

console.log(ready.prompt);
// Verify:
//   1. All four placeholders ({{CLIENT}} / {{JOB}} / {{RESUME}} / {{CURRENT_TIME}}) are gone.
//   2. `## 当前时间\n\n2026-...+08:00 (Asia/Shanghai)` is present.
//   3. `### client\n\nclient_name: 腾讯\ndepartment: 互动娱乐事业群` is present.
//   4. `### 招聘岗位 (Job_Requisition)\n\n```json\n{...}\n```` is present.
//   5. `### 候选人简历 (Resume)\n\n```json\n{...}\n```` is present.
```

## References

- Ontology API (companion repo): `ONTOLOGY-API-USER-GUIDE-BASED-ON-NEO4J.md`
- v3 codegen system (separate commit): includes the full Action mirror snapshot, multi-strategy preview, and the LLM-driven transform pipeline.
