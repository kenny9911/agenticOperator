import { describe, it, expect } from 'vitest';
import { NODES, EDGES, nodeById, GRAPH_VIEWBOX, GRAPH_WIDTH, GRAPH_HEIGHT, CANONICAL_WORKFLOW, TERMINAL_EVENTS } from './workflow-graph-meta';

describe('workflow-graph-meta', () => {
  it('viewBox is 2350x800 (8-column tree with RuleCheck injected)', () => {
    expect(GRAPH_VIEWBOX).toBe('0 0 2350 800');
    expect(GRAPH_WIDTH).toBe(2350);
    expect(GRAPH_HEIGHT).toBe(800);
  });

  it('all edge endpoints resolve to a real node (terminal dashed edges may have empty to)', () => {
    const ids = new Set(NODES.map(n => n.id));
    for (const e of EDGES) {
      expect(ids.has(e.from), `edge ${e.from}->${e.to}: from missing`).toBe(true);
      // Terminal dashed edges (e.g. MATCH_RULE_CHECK_FAILED) may have no consumer node.
      if (e.to !== '') {
        expect(ids.has(e.to), `edge ${e.from}->${e.to}: to missing`).toBe(true);
      }
    }
  });

  it('every node has unique id, in-bounds x/y', () => {
    const seen = new Set<string>();
    for (const n of NODES) {
      expect(seen.has(n.id), `duplicate id ${n.id}`).toBe(false);
      seen.add(n.id);
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThanOrEqual(GRAPH_WIDTH);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeLessThanOrEqual(GRAPH_HEIGHT);
    }
  });

  it('nodeById returns the node or undefined', () => {
    expect(nodeById('jdGenerator')?.title).toBeDefined();
    expect(nodeById('does-not-exist')).toBeUndefined();
  });

  it('has 24 nodes (22 canonical + ruleCheck synthetic + trig)', () => {
    expect(NODES).toHaveLength(24);
    expect(nodeById('ruleCheck')?.wsId).toBe('10-5');
  });

  it('has 29 edges (live AO flow + RuleCheck edges incl. terminal FAILED)', () => {
    // Original 28 edges from canonical JSON, minus the direct resumeParser→matcher edge
    // (RESUME_PROCESSED), plus: resumeParser→ruleCheck, ruleCheck→matcher (PASSED),
    // and ruleCheck→'' (FAILED terminal dashed edge). The live InterviewInviter
    // subscribes to INTERVIEW_INVITATION_REQUESTED (emitted by RAAS/HSM), so the old
    // canonical Matcher→InterviewInviter edge is intentionally absent:
    // 28 - 1 + 1 + 1 + 1 - 1 = 29.
    expect(EDGES).toHaveLength(29);
  });

  it('every non-dashed edge has an eventName populated', () => {
    const solidEdges = EDGES.filter(e => !e.dashed);
    for (const e of solidEdges) {
      expect(
        e.eventName && e.eventName.length > 0,
        `solid edge ${e.from}->${e.to} missing eventName`
      ).toBe(true);
    }
  });

  it('every dashed edge also has an eventName (exception paths are named too)', () => {
    const dashedEdges = EDGES.filter(e => e.dashed);
    for (const e of dashedEdges) {
      expect(
        e.eventName && e.eventName.length > 0,
        `dashed edge ${e.from}->${e.to} missing eventName`
      ).toBe(true);
    }
  });

  it('resumeParser node exists with correct title (title IS canonical agent name)', () => {
    const parse = nodeById('resumeParser');
    expect(parse).toBeDefined();
    expect(parse?.title).toBe('ResumeParser');
    // agentName override not needed when title matches canonical short exactly
    expect(parse?.agentName).toBeUndefined();
  });

  it('all HITL-kind nodes belong to known HITL agents', () => {
    const hitlNodeTitles = NODES.filter(n => n.kind === 'hitl').map(n => n.title);
    // Updated per canonical JSON:
    // - ReClarifier (3-2) added: HITL, CLARIFICATION_INCOMPLETE → CLARIFICATION_RETRY
    // - ResumeCollector (8) is HITL: canonical actor=['Human'] (recruiter downloads manually)
    // - AIInterviewer (11-2) is HITL: canonical actor=['Human'] (candidate self-serve)
    // - MatchReviewer removed: not in canonical workflow spec; MATCH_FAILED is terminal
    const expectedHitl = [
      'JDReviewer', 'ResumeCollector', 'ReClarifier',
      'ManualPublish', 'ResumeFixer', 'AIInterviewer',
      'ManualEntry', 'PackageFiller', 'PackageReviewer',
    ];
    for (const title of hitlNodeTitles) {
      expect(expectedHitl, `unexpected HITL node: ${title}`).toContain(title);
    }
  });

  it('matcher has one in-graph edge and hands NEED_INTERVIEW off to RAAS/HSM', () => {
    // MATCH_PASSED_NO_INTERVIEW continues directly to ResumeRefiner inside AO.
    // MATCH_PASSED_NEED_INTERVIEW is consumed outside this graph by RAAS/HSM,
    // which later emits INTERVIEW_INVITATION_REQUESTED for InterviewInviter.
    // MATCH_FAILED is also terminal; MatchReviewer was removed from the spec.
    const fromMatcher = EDGES.filter(e => e.from === 'matcher');
    expect(fromMatcher).toHaveLength(1);
    const events = fromMatcher.map(e => e.eventName);
    expect(events).toContain('MATCH_PASSED_NO_INTERVIEW');
    expect(events).not.toContain('MATCH_PASSED_NEED_INTERVIEW');
    expect(events).not.toContain('MATCH_FAILED');
    expect(TERMINAL_EVENTS.has('MATCH_PASSED_NEED_INTERVIEW')).toBe(true);
  });

  it('reClarifier node exists (3-2 per canonical JSON)', () => {
    const node = nodeById('reClarifier');
    expect(node).toBeDefined();
    expect(node?.wsId).toBe('3-2');
    expect(node?.kind).toBe('hitl');
    expect(node?.deployment).toBe('conceptual');
    // Edge: clarifier → reClarifier (CLARIFICATION_INCOMPLETE)
    const edge = EDGES.find(e => e.from === 'clarifier' && e.to === 'reClarifier');
    expect(edge).toBeDefined();
    expect(edge?.eventName).toBe('CLARIFICATION_INCOMPLETE');
  });

  it('ruleCheck has both PASSED and FAILED outbound edges', () => {
    const out = EDGES.filter(e => e.from === 'ruleCheck');
    const events = out.map(e => e.eventName).sort();
    expect(events).toContain('MATCH_RULE_CHECK_PASSED');
    expect(events).toContain('MATCH_RULE_CHECK_FAILED');
    const failedEdge = out.find(e => e.eventName === 'MATCH_RULE_CHECK_FAILED');
    expect(failedEdge?.dashed).toBe(true);
  });

  it('resumeParser → ruleCheck edge exists (replacing direct → matcher)', () => {
    const direct = EDGES.find(e => e.from === 'resumeParser' && e.to === 'matcher');
    expect(direct).toBeUndefined();
    const viaRC = EDGES.find(e => e.from === 'resumeParser' && e.to === 'ruleCheck');
    expect(viaRC?.eventName).toBe('RESUME_PROCESSED');
  });

  it('canonical JSON is loaded with all 22 workflow nodes', () => {
    expect(CANONICAL_WORKFLOW).toHaveLength(22);
    // Every NODE_LAYOUT wsId (except trig and AO-owned synthetic nodes) should resolve in CANONICAL_WORKFLOW
    const SYNTHETIC_WSIDS = new Set(['trig', '10-5']);
    const canonicalIds = new Set(CANONICAL_WORKFLOW.map(n => n.id));
    const nonTrigNodes = NODES.filter(n => !SYNTHETIC_WSIDS.has(n.wsId));
    for (const n of nonTrigNodes) {
      expect(canonicalIds.has(n.wsId), `wsId ${n.wsId} (${n.id}) not in canonical JSON`).toBe(true);
    }
  });

  it('deployed nodes are 4 RPA-owned wsIds (incl. RuleCheck)', () => {
    const deployed = NODES.filter(n => n.deployment === 'deployed');
    expect(deployed).toHaveLength(4);
    const wsIds = deployed.map(n => n.wsId).sort();
    expect(wsIds).toEqual(['10', '10-5', '4', '9-1']);
  });

  it('no node centers within 80px of each other (overlap check)', () => {
    for (let i = 0; i < NODES.length; i++) {
      for (let j = i + 1; j < NODES.length; j++) {
        const a = NODES[i], b = NODES[j];
        const dx = Math.abs(a.x - b.x);
        const dy = Math.abs(a.y - b.y);
        const dist = Math.sqrt(dx * dx + dy * dy);
        expect(dist, `nodes ${a.id} and ${b.id} too close: ${dist.toFixed(1)}px`).toBeGreaterThanOrEqual(80);
      }
    }
  });

  it('all node centers inside viewBox bounds (accounting for node size 154x64)', () => {
    const NODE_W = 154;
    const NODE_H = 64;
    for (const n of NODES) {
      // All nodes including the trigger are now within bounds in the 2200×800 viewBox.
      expect(n.x - NODE_W / 2, `${n.id} left edge (x=${n.x}) overflows viewBox`).toBeGreaterThanOrEqual(0);
      expect(n.x + NODE_W / 2, `${n.id} right edge (x=${n.x}) overflows viewBox`).toBeLessThanOrEqual(GRAPH_WIDTH);
      expect(n.y - NODE_H / 2, `${n.id} top edge (y=${n.y}) overflows viewBox`).toBeGreaterThanOrEqual(0);
      expect(n.y + NODE_H / 2, `${n.id} bottom edge (y=${n.y}) overflows viewBox`).toBeLessThanOrEqual(GRAPH_HEIGHT);
    }
  });

  it('TERMINAL_EVENTS contains MATCH_FAILED and other known terminal events', () => {
    expect(TERMINAL_EVENTS.has('MATCH_FAILED'), 'MATCH_FAILED should be terminal').toBe(true);
    // MATCH_FAILED has no consumer in canonical JSON — MatchReviewer was removed
    // TERMINAL_EVENTS should be non-empty (there are several terminal states in the workflow)
    expect(TERMINAL_EVENTS.size).toBeGreaterThan(0);
    expect(TERMINAL_EVENTS.has('MATCH_RULE_CHECK_FAILED'), 'MATCH_RULE_CHECK_FAILED should be terminal (no consumer)').toBe(true);
  });
});
