// The generation pipeline — "agents generate agents". Reads a domain's ontology
// (Neo4j-first via fetchRunnableOntology, snapshot fallback), and for each
// Agent action produces a declarative GeneratedAgentSpec: tools selected from
// the registry (generation-time scoping), prompt synthesized by an LLM when the
// gateway is reachable (degrading to a deterministic ontology template), events
// wired via the shared context. Deterministic backbone guarantees a valid agent;
// the LLM only enriches — the "薄 loop + 厚 harness" thesis.

import { chatComplete, isGatewayConfigured } from "@/server/llm/gateway";
import type { OntologyAction } from "@/lib/ontology-generator/ontology-source";
import { selectToolsForAction, toolSignature, toolParamSummary, type ToolRegistry } from "@/lib/tools/registry";
import { buildContext, actionRole, type GenerationContext } from "./context";
import { validate } from "./validate";
import type {
  GeneratedAgentSpec,
  GeneratedStep,
  GenerateResult,
  PromptSource,
  GenEventSink,
  PromptRefinement,
  PromptCritique,
  PromptIssue,
  RefinementRound,
  HitlGate,
} from "./types";

export interface GenerateOptions {
  /** registry to compose from (defaults to the recruitment tool library) */
  registry?: ToolRegistry;
  /** use the LLM gateway for prompt synthesis. Tests pass false → hermetic. */
  useLlm?: boolean;
  /** optional human steering woven into LLM prompt synthesis (no effect when useLlm=false) */
  instruction?: string;
  /** stream the factory's internal reasoning live (ontology read, per-agent tool
   *  selection, LLM request/response, validation, …) — for the SSE surface */
  onEvent?: GenEventSink;
  /** human-perceptible delay (ms) between streamed steps so the reasoning is
   *  watchable; 0 (default) = instant (non-stream calls + tests stay fast) */
  paceMs?: number;
}

// ontology actions in snapshots carry richer fields than the typed OntologyAction
export type RichAction = OntologyAction & {
  action_steps?: Array<{ name?: string; description?: string; rules?: Array<{ id?: string }> }>;
};

export const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[_\s]+/g, "-").toLowerCase();
export const pascal = (s: string) => s.replace(/(^|[-_\s]+)([a-zA-Z0-9])/g, (_, __, c: string) => c.toUpperCase());
export const slugifyDomain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "domain";

/** A human Chinese label: first clause of the description, else category, else name. */
function zhLabel(a: RichAction): string {
  const firstClause = (a.description ?? "").split(/[。;，,;\n]/)[0]?.trim() ?? "";
  return firstClause.slice(0, 18) || a.category || a.name;
}

/** retries heuristic mirroring the real recruitment agents:
 *  parse-style (no auto-retry, avoid double quota/DB writes) = 0;
 *  match/invite (vendor-flaky, safe to retry) = 2; everything else = 1. */
export function inferRetries(tools: string[]): number {
  if (tools.includes("robohire.parseResume")) return 0;
  if (tools.includes("robohire.matchResume") || tools.includes("robohire.inviteCandidate")) return 2;
  return 1;
}

export function ruleRefsOf(a: RichAction): string[] {
  const ids = new Set<string>();
  for (const s of a.action_steps ?? []) for (const r of s.rules ?? []) if (r.id) ids.add(r.id);
  return [...ids];
}

export function deriveSteps(a: RichAction, tools: string[]): GeneratedStep[] {
  if (a.action_steps?.length) {
    const steps: GeneratedStep[] = a.action_steps.map((s, i) => ({
      name: s.name ?? `step-${i + 1}`,
      description: (s.description ?? "").replace(/\s+/g, " ").trim(),
      tool: tools[i],
    }));
    // bind any remaining selected tools to their own steps so declared work isn't
    // silently dropped when an action has more tools than steps.
    for (let j = a.action_steps.length; j < tools.length; j++) {
      steps.push({ name: `call-${tools[j]}`, description: `调用 ${tools[j]}`, tool: tools[j] });
    }
    return steps;
  }
  // no declared steps → one step per tool, else a single execute step
  if (tools.length) return tools.map((t) => ({ name: `call-${t}`, description: `调用 ${t}`, tool: t }));
  return [{ name: "execute", description: "执行该 action 的核心逻辑" }];
}

const oneLine = (s = "") => s.replace(/\s+/g, " ").trim();

/** Heuristic "when to emit" scaffold from the event name, so the deterministic
 *  prompt has CONCRETE decision conditions instead of just a list of events. */
function emitCondition(name: string): string {
  if (/PASS|通过|SENT|GENERATED|CHECKED|SUCCESS|DONE|PROCESSED|LOGGED/i.test(name)) return "工具校验/操作成功且规则护栏全部满足时";
  if (/FAIL|失败|未通过|REJECT|CONFLICT|ERROR|DENIED|LOCKED/i.test(name)) return "规则未通过或工具返回失败时(write-only 落库,不抛错)";
  if (/REQUEST|REQUESTED|NEED|PENDING|REVIEW|CLARIFICATION/i.test(name)) return "需要进入下一环节或等待外部/人工时";
  return "满足该结论对应的业务条件时";
}

/** Rich tool lines: signature (params → returns) + 用途 + 副作用 — so the prompt
 *  knows exactly HOW to call each tool and what it returns, not just the name. */
function toolDetailLines(tools: string[], ctx: GenerationContext): string {
  return tools
    .map((t) => {
      const td = ctx.registry.get(t);
      if (!td) return `- ${t}`;
      return `- ${toolSignature(td)}\n    用途:${oneLine(td.description)}  [副作用:${td.sideEffect}]`;
    })
    .join("\n");
}

/** The ordered execution plan: each step → the registry tool it calls (w/ params). */
function stepPlanLines(steps: GeneratedStep[], ctx: GenerationContext): string {
  return steps
    .map((s, i) => {
      const td = s.tool ? ctx.registry.get(s.tool) : undefined;
      const call = td ? `调用 ${td.name}(${toolParamSummary(td)})` : s.tool ? `调用 ${s.tool}` : "(确定性/判定逻辑)";
      // omit the auto-generated "调用 X" description so it isn't shown twice
      const desc = s.description && s.description !== `调用 ${s.tool}` ? ` — ${oneLine(s.description)}` : "";
      return `${i + 1}. ${s.name}${desc} → ${call}`;
    })
    .join("\n");
}

/** Deterministic ontology-template prompt — always available, no network. Now a
 *  structured, TOOL-AWARE prompt: role/boundary, data objects, tool signatures,
 *  an ordered step plan, rule guards, and per-event decision conditions. */
export function templatePrompt(a: RichAction, ctx: GenerationContext, tools: string[], steps: GeneratedStep[]): { system: string; user: string } {
  const emit = (a.triggered_event ?? []).filter((e) => e && e !== "—");
  const g = buildGrounding(a, ctx, tools);
  const decisionLines = emit.map((e) => `- ${e} — 何时发出:${emitCondition(e)}`).join("\n");
  const system = [
    `你是「${a.category ?? ctx.domainId}」域的 ${a.name} agent。${oneLine(a.description ?? "")}`,
    `【角色与边界】只使用下面声明的工具与数据对象,不调用未注册工具、不捏造事件。业务判定为 FAIL/未通过是合法结论(write-only 落库,不要 throw);只有基础设施故障(工具不可达等)才向上抛错。`,
    `【触发事件】${(a.trigger ?? []).join(", ") || "—"}`,
    g.objs ? `【数据对象与字段】\n${g.objs}` : "",
    `【可用工具(按签名调用)】\n${toolDetailLines(tools, ctx) || "（无,纯判定 agent)"}`,
    `【执行步骤(按序)】\n${stepPlanLines(steps, ctx)}`,
    g.ruleLines.length ? `【规则护栏(必须遵守,沿用现有 rules,不改写语义)】\n${g.ruleLines.join("\n")}` : "",
    `【决策:在以下事件中选恰好一个作为结论】\n${decisionLines || "- （无下游事件)"}`,
    `【输出】只返回 JSON:{"decision": <上面某个事件名>, "reason": <简要原因>}。`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const user =
    (a.user_prompt && a.user_prompt.trim()) ||
    `针对运行时输入,按【执行步骤】依次调用工具,再依据工具返回与规则护栏在【决策】列出的事件中选择结论,按【输出】格式返回。`;
  return { system, user };
}

async function safeLlmComplete(system: string, user: string): Promise<string> {
  if (!isGatewayConfigured()) return "";
  try {
    const r = await chatComplete({ system, user, temperature: 0.3, maxTokens: 900, toolName: "factory.promptgen" });
    return (r.text ?? "").trim();
  } catch {
    return "";
  }
}

/** Assemble rich ontology grounding for the prompt-authoring agent: the action's
 *  data objects + their fields, the events it may emit + their payloads, the rule
 *  guards, the bound tools + descriptions, and the sibling agents (for event
 *  wiring). The LLM AUTHORS the system prompt from this — it is not given a
 *  template to lightly reword. */
export function buildGrounding(a: RichAction, ctx: GenerationContext, tools: string[]) {
  const objById = new Map(ctx.ontology.objects.map((o) => [o.id, o] as const));
  const evByName = new Map(ctx.ontology.events.map((e) => [e.name, e] as const));
  const objs = (a.target_objects ?? [])
    .map((id) => {
      const o = objById.get(id);
      if (!o) return `- ${id}`;
      const props = (o.properties ?? []).slice(0, 12).map((p) => `${p.name}:${p.type ?? "?"}`).join(", ");
      return `- ${o.id}(${o.name ?? ""})${props ? ` 字段[${props}]` : ""}`;
    })
    .join("\n");
  const emitEvents = (a.triggered_event ?? [])
    .filter((e) => e && e !== "—")
    .map((name) => {
      const e = evByName.get(name);
      const ed = e ? (e.payload?.event_data ?? []).map((d) => d.name).join(", ") : "";
      return `- ${name}${ed ? `(payload: ${ed})` : ""}`;
    })
    .join("\n");
  // resolve rule descriptions from the ontology rule catalog (the action_steps
  // only inline the rule id; the human-readable name + logic live in rules.json).
  const ruleCatalog = new Map<string, { name?: string; logic?: string }>();
  for (const r of ctx.ontology.rules ?? []) {
    const rr = r as Record<string, unknown>;
    const id = typeof rr.id === "string" ? rr.id : undefined;
    if (id) {
      ruleCatalog.set(id, {
        name: typeof rr.businessLogicRuleName === "string" ? rr.businessLogicRuleName : undefined,
        logic: typeof rr.standardizedLogicRule === "string" ? rr.standardizedLogicRule : undefined,
      });
    }
  }
  const ruleLines = (a.action_steps ?? [])
    .flatMap((s) => (s.rules ?? []).map((r) => {
      const rr = r as { id?: string; description?: string };
      const cat = rr.id ? ruleCatalog.get(rr.id) : undefined;
      const body = oneLine(rr.description || cat?.logic || "").slice(0, 160);
      return `- [${rr.id ?? ""}] ${cat?.name ? cat.name + (body ? ":" : "") : ""}${body}`;
    }))
    // keep only lines that carry real content after the id
    .filter((l) => l.replace(/- \[[^\]]*\]\s*/, "").length > 2)
    .slice(0, 12);
  // signature + 用途 + 副作用 (shared with the deterministic template) so the
  // LLM can write precise per-tool call instructions, not vague references.
  const toolLines = toolDetailLines(tools, ctx);
  const siblings = ctx.specs.map((s) => `${s.actionName}:${s.trigger.join("/")}→${s.emit.join("/")}`).join("; ");
  return { objs, emitEvents, ruleLines, toolLines, siblings };
}

// ── Agent-Loop: bounded prompt-refinement (DRAFT → CRITIQUE → REVISE) ──────────
// After the LLM drafts a prompt, a critic LLM scores it (0..1) against a rubric
// GROUNDED in the same ontology facts (allowed events + tools + rules), and a
// reviser rewrites it to fix actionable issues. Up to K rounds, stop early when
// good enough or converged. This is the only "agent loop" in the runtime — it's
// offline (generation-time), so iteration cost is amortized over every future
// run of the deployed agent. Degrades gracefully (gateway down → keep the draft).
const REFINE_ENABLED = process.env.FACTORY_REFINE !== "0";
const REFINE_K = 2;
const REFINE_THRESHOLD = 0.85;

async function safeCritique(system: string, user: string): Promise<string> {
  if (!isGatewayConfigured()) return "";
  try {
    const r = await chatComplete({ system, user, temperature: 0.2, maxTokens: 350, toolName: "factory.promptcritic" });
    return (r.text ?? "").trim();
  } catch {
    return "";
  }
}

/** Tolerant parse of the critic's JSON ({score, issues}); strips fences, takes
 *  the first {...} block. Returns null on anything unusable → caller degrades. */
function parseCritique(raw: string): PromptCritique | null {
  if (!raw) return null;
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as { score?: number; issues?: PromptIssue[] };
    if (typeof o.score !== "number") return null;
    const score = Math.max(0, Math.min(1, o.score));
    const issues = Array.isArray(o.issues) ? o.issues.filter((i) => i && i.what).slice(0, 8) : [];
    return { score, issues };
  } catch {
    return null;
  }
}

const issueSig = (i: PromptIssue) => `${i.dim}:${oneLine(i.what).slice(0, 40)}`;

/** Run the bounded reflexion loop on a drafted prompt. Emits prompt-critique /
 *  prompt-revise GenEvents so the 推理 panel streams the self-improvement. */
async function refinePrompt(
  draft: string,
  g: ReturnType<typeof buildGrounding>,
  ctx: GenerationContext,
  a: RichAction,
  tools: string[],
): Promise<{ prompt: string; meta: PromptRefinement }> {
  const allowedEvents = (a.triggered_event ?? []).filter((e) => e && e !== "—");
  const rubric =
    `请作为严格的 prompt 审查员,对下面这份业务 agent 的 system prompt 评分(0..1)。\n` +
    `事实依据(prompt 必须严格符合,任何偏离都要扣分并列为 issue):\n` +
    `· 只能发出的决策事件: ${allowedEvents.join(", ") || "（无）"}\n` +
    `· 只能使用的工具: ${tools.join(", ") || "（无）"}\n` +
    (g.ruleLines.length ? `· 必须保留的规则护栏: ${g.ruleLines.join(" | ")}\n` : "") +
    `评分维度(逐条检查): ① coverage 是否覆盖【每一个】可发出事件的选择条件;` +
    `② tools 是否只用上面列出的工具(出现表外工具=hallucination,重扣);` +
    `③ events 是否只发出上面列出的事件(表外事件=hallucination,重扣);` +
    `④ json 输出格式是否为 {"decision":<事件名>,"reason":...};` +
    `⑤ rules 规则护栏是否全部出现;⑥ role 角色与边界是否清晰(FAIL 只落库不抛错)。\n` +
    `只返回 JSON:{"score":0..1,"issues":[{"severity":"high|med|low","dim":"coverage|tools|events|json|rules|role","what":"","fix":""}]}。无问题则 issues 为空。不要任何解释或代码块标记。`;

  let best = draft;
  let bestScore = 0;
  let prevSigs = new Set<string>();
  const history: RefinementRound[] = [];
  let issuesFixed = 0;
  let converged = false;
  let current = draft;

  for (let iter = 1; iter <= REFINE_K; iter++) {
    const crit = parseCritique(await safeCritique(rubric, `待审查的 system prompt:\n\n${current}`));
    if (!crit) {
      // gateway hiccup / unparseable — if it's the first round, skip entirely.
      if (iter === 1) return { prompt: best, meta: { iterations: 0, finalScore: 0, issuesFixed: 0, converged: false, skipped: true, history } };
      break;
    }
    ctx.emit({ t: "prompt-critique", actionName: a.name, iteration: iter, score: crit.score, issues: crit.issues });
    await ctx.pace();
    if (crit.score > bestScore) {
      best = current;
      bestScore = crit.score;
    }

    const sigs = new Set(crit.issues.map(issueSig));
    const newIssues = [...sigs].some((s) => !prevSigs.has(s));
    const actionable = crit.issues.filter((i) => i.severity !== "low");
    // stop: good enough, converged (no new issues), or nothing actionable
    if (crit.score >= REFINE_THRESHOLD || !newIssues || actionable.length === 0) {
      converged = true;
      history.push({ iteration: iter, score: crit.score, issues: crit.issues, revised: false });
      break;
    }

    const fixList = actionable.map((i) => `· [${i.severity}/${i.dim}] ${oneLine(i.what)} → 修复:${oneLine(i.fix)}`).join("\n");
    const revised = await safeLlmComplete(
      "你是资深多智能体 prompt 工程师,根据审查意见改写 prompt,只修该改的,不要削弱已正确的约束。",
      `当前 system prompt:\n\n${current}\n\n审查发现以下需修复的问题:\n${fixList}\n\n` +
        `请输出修复后的完整 system prompt 正文(必须仍只发出: ${allowedEvents.join(", ") || "（无）"};` +
        `只用工具: ${tools.join(", ") || "（无）"};保留 JSON 输出格式)。只返回正文,无解释、无代码块标记。`,
    );
    const changed = !!revised && revised.length > 40 && revised !== current;
    if (changed) {
      current = revised;
      issuesFixed += actionable.length;
    }
    history.push({ iteration: iter, score: crit.score, issues: crit.issues, revised: changed });
    ctx.emit({ t: "prompt-revise", actionName: a.name, iteration: iter, changed, source: "llm" });
    await ctx.pace();
    if (!changed) break; // reviser stalled
    prevSigs = sigs;
  }

  const lastScore = history.length ? history[history.length - 1].score : 0;
  const finalScore = Math.max(bestScore, lastScore);
  // prefer the highest-SCORED prompt over a final un-scored rewrite. `best` equals
  // `draft` (by ref) exactly when the draft itself scored highest — which is the
  // case we must KEEP, so do NOT exclude best===draft here.
  const finalPrompt = bestScore > 0 && bestScore >= lastScore ? best : current;
  return { prompt: finalPrompt, meta: { iterations: history.length, finalScore, issuesFixed, converged, skipped: false, history } };
}

/** The system prompt is AUTHORED by an LLM (the prompt-generation agent) from the
 *  ontology grounding — including the decision logic for choosing among emit
 *  events, then iteratively refined by a small critique→revise loop. The
 *  deterministic template is only a fallback (gateway down / empty).
 *  Structure (which tools / which events) stays ontology-determined (no halluc.);
 *  the LLM designs and refines the behavior prose. */
async function synthesizePrompt(
  a: RichAction,
  ctx: GenerationContext,
  tools: string[],
  steps: GeneratedStep[],
  useLlm: boolean,
  instruction?: string,
): Promise<{ system: string; user: string; source: PromptSource; refinement?: PromptRefinement }> {
  const tpl = templatePrompt(a, ctx, tools, steps);
  if (!useLlm) return { ...tpl, source: "ontology" };

  const g = buildGrounding(a, ctx, tools);
  const designPrompt = [
    `请为一个业务 agent 设计它的 system prompt。`,
    `职责:${oneLine(a.description ?? a.name)}(业务域:${a.category ?? ctx.domainId})。`,
    `触发事件:${(a.trigger ?? []).join(", ") || "—"}。`,
    `它【只能】发出以下事件之一作为决策结论(不得发出其它事件):\n${g.emitEvents || "- （无）"}`,
    `它【只能】使用以下工具(签名 = 入参→返回,不得编造其它工具):\n${g.toolLines || "- （无）"}`,
    `按此顺序调用工具(执行计划):\n${stepPlanLines(steps, ctx)}`,
    g.objs ? `相关数据对象与字段:\n${g.objs}` : "",
    g.ruleLines.length ? `必须遵守的规则护栏(沿用现有规则,不得改写其语义):\n${g.ruleLines.join("\n")}` : "",
    `同域已生成的兄弟 agent(用于对齐事件接线,不要与之冲突):${g.siblings || "（暂无）"}`,
    instruction && instruction.trim() ? `运营额外指示:${instruction.trim()}` : "",
    `要求:写一份清晰、可执行的中文 system prompt,必须覆盖 ① 角色与边界;② 依次如何调用上面的工具(引用其签名/入参);③ 如何依据工具返回结果与规则做判定;④ 如何在上面"可发出事件"之间做出选择(给出明确的决策条件);⑤ 输出 JSON 格式 {"decision": <上面某个事件名>, "reason": <简要原因>}。`,
    `注意:业务判定为 FAIL/未通过是合法结论(只 write-only 落库,不要 throw);只有基础设施故障(工具不可达等)才向上抛错。只返回 system prompt 正文,不要任何解释或 markdown 代码块标记。`,
  ]
    .filter(Boolean)
    .join("\n\n");

  ctx.emit({ t: "llm-request", actionName: a.name, prompt: designPrompt });
  await ctx.pace();
  const authored = await safeLlmComplete(
    "你是资深的多智能体系统 prompt 工程师,擅长把业务规则与工具编排写成可执行的 agent system prompt。",
    designPrompt,
  );
  const source: PromptSource = authored && authored.length > 40 ? "llm" : isGatewayConfigured() ? "fallback" : "ontology";
  ctx.emit({ t: "llm-response", actionName: a.name, text: authored || "(空 / 网关不可达 → 降级到本体模板)", source });
  if (source === "llm") {
    ctx.log.push(`[llm] system prompt authored for ${a.name}`);
    if (!REFINE_ENABLED) return { system: authored, user: tpl.user, source };
    // Agent-Loop: critique → revise the draft against the ontology grounding.
    const { prompt, meta } = await refinePrompt(authored, g, ctx, a, tools);
    ctx.log.push(`[refine] ${a.name} iters=${meta.iterations} score=${meta.finalScore.toFixed(2)} fixed=${meta.issuesFixed}`);
    return { system: prompt, user: tpl.user, source, refinement: meta };
  }
  return { ...tpl, source };
}

/** Build the declarative HITL gate descriptor for a Human-actor action. The
 *  executor waits on `<domain>/HUMAN_DECISION` (matching its ns()) instead of
 *  auto-deciding; the decision routes to one of the action's emit events. */
function buildHitlGate(a: RichAction, ctx: GenerationContext): HitlGate {
  const emits = (a.triggered_event ?? []).filter((e) => e && e !== "—");
  return {
    gateKey: a.name,
    eventNs: ctx.domainId,
    decisionEvent: `${ctx.domainId}/HUMAN_DECISION`,
    emitOnDecision: {},
    defaultEmit: emits[0],
    title: zhLabel(a),
    body: oneLine(a.description ?? "").slice(0, 160),
  };
}

async function generateOne(a: RichAction, ctx: GenerationContext, useLlm: boolean, instruction?: string): Promise<GeneratedAgentSpec> {
  const role = actionRole(a);
  const { tools, unresolved } = selectToolsForAction(a, ctx.registry);
  ctx.emit({ t: "tools", actionName: a.name, tools, unresolved });
  await ctx.pace();
  if (role === "hitl") ctx.emit({ t: "hitl", actionName: a.name, gateKey: a.name });
  ctx.emit({ t: "prompt-mode", actionName: a.name, useLlm });
  // derive the step plan first so the prompt is built FROM the actual tool steps
  const steps = deriveSteps(a, tools);
  const { system, user, source, refinement } = await synthesizePrompt(a, ctx, tools, steps, useLlm, instruction);
  const slug = `${slugifyDomain(ctx.domainId)}-${kebab(a.name)}`;
  // HITL (Human-actor) actions become human-gate agents (simulated-human), kept
  // instead of dropped. Pure LLM agents are "llm". recruitment actions are all
  // actor=agent → hitl stays false (verified against the 6 real agents).
  const kind: GeneratedAgentSpec["kind"] = role === "agent" ? "llm" : "simulated-human";
  const refinedHigh = refinement && refinement.finalScore >= REFINE_THRESHOLD;
  return {
    key: a.name,
    actionName: a.name,
    slug,
    short: `${pascal(a.name)}Agent`,
    domainId: ctx.domainId,
    nameZh: zhLabel(a),
    kind,
    trigger: [...(a.trigger ?? [])],
    emit: [...(a.triggered_event ?? [])],
    tools,
    unresolvedTools: unresolved,
    objects: [...(a.target_objects ?? [])],
    systemPrompt: system,
    userPrompt: user,
    steps,
    ruleRefs: ruleRefsOf(a),
    retries: inferRetries(tools),
    hitl: role === "hitl",
    confidence: source === "llm" ? (refinedHigh ? 95 : 90) : 75,
    promptSource: source,
    refinement,
    ...(role === "hitl" ? { hitlGate: buildHitlGate(a, ctx) } : {}),
  };
}

/** Generate the full agent set for a domain. Each Agent action becomes one spec;
 *  the shared context accumulates specs so later agents see earlier ones. */
export async function generateAgents(domainId: string, opts: GenerateOptions = {}): Promise<GenerateResult> {
  const useLlm = opts.useLlm ?? true;
  // The registry is resolved inside buildContext from the domain's ontology
  // (recruitment → hand-coded library; other domains → declared/generic).
  // opts.registry overrides (tests).
  const ctx = await buildContext(domainId, opts.registry, opts.onEvent, opts.paceMs ?? 0);

  // Keep "agent" (LLM) AND "hitl" (Human-gate) actions; only "other"
  // (system/automated) actions are not turned into generated agents.
  const actions = (ctx.ontology.actions as RichAction[]).filter((a) => {
    const r = actionRole(a);
    return r === "agent" || r === "hitl";
  });
  ctx.emit({ t: "ontology", domain: domainId, source: ctx.ontology.source, actions: ctx.ontology.actions.length, events: ctx.ontology.events.length, agentActions: actions.length });
  ctx.log.push(`generating ${actions.length} agent action(s); useLlm=${useLlm}`);
  ctx.emit({ t: "log", line: `读取本体完成,${actions.length} 个 Agent action 待生成(useLlm=${useLlm})` });
  await ctx.pace();

  let i = 0;
  for (const action of actions) {
    ctx.emit({ t: "agent-start", actionName: action.name, index: i++, total: actions.length });
    await ctx.pace();
    const spec = await generateOne(action, ctx, useLlm, opts.instruction);
    ctx.specs.push(spec); // grows the shared blackboard
    ctx.emit({ t: "agent-done", spec });
    await ctx.pace();
  }

  const validation = validate(ctx);
  ctx.emit({ t: "validation", report: validation });
  return {
    domainId,
    source: ctx.ontology.source,
    specs: ctx.specs,
    validation,
    log: ctx.log,
    llmUsedCount: ctx.specs.filter((s) => s.promptSource === "llm").length,
  };
}
