import { describe, it, expect, vi } from 'vitest';
import {
  createGuardedDispatcher,
  EMPTY_RESULT_NOTE,
  ERROR_RESULT_NOTE,
  REPEAT_RESULT_NOTE,
} from './tool-guard';

describe('createGuardedDispatcher', () => {
  it('passes a real hit through unchanged and traces it', async () => {
    const inner = vi.fn().mockResolvedValue({ id: 'C1' });
    const g = createGuardedDispatcher(inner);
    expect(await g.dispatch('get_instance', { label: 'Candidate', value: 'C1' })).toEqual({ id: 'C1' });
    expect(g.trace).toEqual([{ name: 'get_instance', args: '{"label":"Candidate","value":"C1"}', outcome: 'hit' }]);
  });

  it('annotates empty results (null / []) with a stop-guessing note', async () => {
    const inner = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce([]);
    const g = createGuardedDispatcher(inner);
    expect(await g.dispatch('get_instance', { label: 'Relative', value: 'x' })).toEqual({ result: null, note: EMPTY_RESULT_NOTE });
    expect(await g.dispatch('list_links', { type: 'RELATIVE_OF' })).toEqual({ result: [], note: EMPTY_RESULT_NOTE });
    expect(g.trace.map((t) => t.outcome)).toEqual(['empty', 'empty']);
  });

  it('annotates error envelopes', async () => {
    const g = createGuardedDispatcher(vi.fn().mockResolvedValue({ error: 'HTTP 500' }));
    expect(await g.dispatch('list_instances', { label: 'X' })).toEqual({ error: 'HTTP 500', note: ERROR_RESULT_NOTE });
  });

  it('answers a repeated identical call from cache (key order-insensitive) without refetching', async () => {
    const inner = vi.fn().mockResolvedValue({ id: 'J1' });
    const g = createGuardedDispatcher(inner);
    await g.dispatch('get_instance', { label: 'Job_Requisition', value: 'J1' });
    const again = await g.dispatch('get_instance', { value: 'J1', label: 'Job_Requisition' });
    expect(again).toEqual({ result: { id: 'J1' }, note: REPEAT_RESULT_NOTE });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(g.callCount()).toBe(2);
    expect(g.summary()).toMatch(/^2 次调用 · 命中 1 · 空 0 · 重复 1 · 失败 0/);
  });

  it('still propagates an unknown-tool throw', async () => {
    const g = createGuardedDispatcher(vi.fn().mockRejectedValue(new Error('unknown tool: nope')));
    await expect(g.dispatch('nope', {})).rejects.toThrow(/unknown tool/);
  });

  it('caps the trace but keeps counting', async () => {
    const g = createGuardedDispatcher(vi.fn().mockResolvedValue([]));
    for (let i = 0; i < 50; i++) await g.dispatch('list_instances', { label: `L${i}` });
    expect(g.trace).toHaveLength(40);
    expect(g.callCount()).toBe(50);
  });
});
