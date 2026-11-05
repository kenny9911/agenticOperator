import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// We mock the `openai` module to control the create() responses.
const createMock = vi.fn();
vi.mock('openai', () => {
  function OpenAIMock() {
    return { chat: { completions: { create: createMock } } };
  }
  return { default: OpenAIMock };
});

import { chatComplete } from './gateway';

beforeEach(() => {
  process.env.AI_BASE_URL = 'http://gateway/v1';
  process.env.AI_API_KEY = 'test-key';
  process.env.AI_MODEL = 'test-model';
  createMock.mockReset();
});
afterEach(() => {
  delete process.env.AI_BASE_URL;
  delete process.env.AI_API_KEY;
  delete process.env.AI_MODEL;
});

describe('chatComplete (existing single-turn behavior preserved)', () => {
  it('returns the assistant text for a tool-less call', async () => {
    createMock.mockResolvedValueOnce({
      choices: [{ message: { content: 'hello' } }],
      usage: { total_tokens: 10 },
    });
    const out = await chatComplete({ system: 'sys', user: 'u' });
    expect(out.text).toBe('hello');
    expect(out.modelUsed).toBe('test-model');
  });
});

describe('chatComplete with tools', () => {
  it('drives one tool round then returns final text', async () => {
    createMock.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'tc_1',
                type: 'function',
                function: { name: 'get_instance', arguments: '{"label":"Candidate","value":"C-1"}' },
              },
            ],
          },
        },
      ],
    });
    createMock.mockResolvedValueOnce({
      choices: [{ message: { content: 'final answer' } }],
    });

    const dispatcher = vi.fn().mockResolvedValueOnce({ candidate_id: 'C-1' });

    const out = await chatComplete({
      system: 'sys',
      user: 'u',
      tools: {
        schema: [
          {
            type: 'function',
            function: {
              name: 'get_instance',
              description: 'Fetch one instance.',
              parameters: {
                type: 'object',
                properties: { label: { type: 'string' }, value: { type: 'string' } },
                required: ['label', 'value'],
              },
            },
          },
        ],
        onToolCall: dispatcher,
      },
    });

    expect(out.text).toBe('final answer');
    expect(out.toolUseIterations).toBe(1);
    expect(dispatcher).toHaveBeenCalledWith('get_instance', {
      label: 'Candidate',
      value: 'C-1',
    });
    // Second create() call should have the tool result threaded in messages.
    const secondCall = createMock.mock.calls[1]?.[0] as { messages: unknown[] };
    expect(secondCall.messages.length).toBeGreaterThanOrEqual(4);
    const toolMsg = secondCall.messages.find(
      (m): m is { role: string; tool_call_id: string; content: string } =>
        typeof m === 'object' && m !== null && (m as { role: string }).role === 'tool',
    );
    expect(toolMsg?.tool_call_id).toBe('tc_1');
    expect(JSON.parse(toolMsg!.content)).toEqual({ candidate_id: 'C-1' });
  });

  it('throws when tool-use loop exceeds maxIterations', async () => {
    const toolCallResponse = {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'tc_x',
                type: 'function',
                function: { name: 'get_instance', arguments: '{}' },
              },
            ],
          },
        },
      ],
    };
    // Always return a tool_call — loop should never converge.
    createMock.mockResolvedValue(toolCallResponse);
    const dispatcher = vi.fn().mockResolvedValue({});

    await expect(
      chatComplete({
        system: 'sys',
        user: 'u',
        tools: {
          schema: [
            {
              type: 'function',
              function: {
                name: 'get_instance',
                parameters: { type: 'object', properties: {} },
              },
            },
          ],
          onToolCall: dispatcher,
          maxIterations: 2,
        },
      }),
    ).rejects.toThrow(/tool-use loop exceeded/);
    expect(dispatcher).toHaveBeenCalledTimes(2);
  });

  describe('finalizeOnLimit', () => {
    const toolCallResponse = {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: 'tc_x', type: 'function', function: { name: 'get_instance', arguments: '{}' } },
            ],
          },
        },
      ],
    };
    const schema = [
      {
        type: 'function' as const,
        function: { name: 'get_instance', parameters: { type: 'object', properties: {} } },
      },
    ];

    it('forces a tools-disabled final round instead of throwing', async () => {
      createMock
        .mockResolvedValueOnce(toolCallResponse)
        .mockResolvedValueOnce(toolCallResponse)
        .mockResolvedValueOnce({ choices: [{ message: { content: '{"rule_results":[]}' } }] });
      const dispatcher = vi.fn().mockResolvedValue({});

      const out = await chatComplete({
        system: 'sys',
        user: 'u',
        tools: { schema, onToolCall: dispatcher, maxIterations: 2, finalizeOnLimit: 'NO MORE TOOLS' },
      });

      expect(out.text).toBe('{"rule_results":[]}');
      expect(out.toolUseIterations).toBe(2);
      expect(dispatcher).toHaveBeenCalledTimes(2);
      expect(createMock).toHaveBeenCalledTimes(3);
      const finalArgs = createMock.mock.calls[2][0];
      expect(finalArgs.tool_choice).toBe('none');
      const last = finalArgs.messages[finalArgs.messages.length - 1];
      expect(last).toEqual({ role: 'user', content: 'NO MORE TOOLS' });
    });

    it('still throws if the final round returns tool_calls with no text', async () => {
      createMock.mockResolvedValue(toolCallResponse);
      const dispatcher = vi.fn().mockResolvedValue({});

      await expect(
        chatComplete({
          system: 'sys',
          user: 'u',
          tools: { schema, onToolCall: dispatcher, maxIterations: 2, finalizeOnLimit: 'NO MORE TOOLS' },
        }),
      ).rejects.toThrow(/tool-use loop exceeded/);
      // Tools from the ignored final round are NOT dispatched.
      expect(dispatcher).toHaveBeenCalledTimes(2);
      expect(createMock).toHaveBeenCalledTimes(3);
    });
  });

  it('does not dispatch malformed tool arguments; reports them back to the model', async () => {
    createMock
      .mockResolvedValueOnce({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: null,
              tool_calls: [{ id: 'tc_bad', type: 'function', function: { name: 'get_instance', arguments: '{"label":"Cand' } }],
            },
          },
        ],
      })
      .mockResolvedValueOnce({ choices: [{ message: { content: 'done' } }] });
    const dispatcher = vi.fn();
    const out = await chatComplete({
      system: 'sys',
      user: 'u',
      tools: {
        schema: [{ type: 'function', function: { name: 'get_instance', parameters: { type: 'object', properties: {} } } }],
        onToolCall: dispatcher,
      },
    });
    expect(out.text).toBe('done');
    expect(dispatcher).not.toHaveBeenCalled();
    const toolMsg = createMock.mock.calls[1][0].messages.find((m: { role: string }) => m.role === 'tool');
    expect(JSON.parse(toolMsg.content).error).toMatch(/not valid JSON/);
  });

  it('loop-exceeded error names the last finish_reason', async () => {
    createMock.mockResolvedValue({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: { content: null, tool_calls: [{ id: 't', type: 'function', function: { name: 'get_instance', arguments: '{}' } }] },
        },
      ],
    });
    await expect(
      chatComplete({
        system: 'sys',
        user: 'u',
        tools: {
          schema: [{ type: 'function', function: { name: 'get_instance', parameters: { type: 'object', properties: {} } } }],
          onToolCall: vi.fn().mockResolvedValue({}),
          maxIterations: 1,
        },
      }),
    ).rejects.toThrow(/tool-use loop exceeded 1 iterations.*finish_reason=tool_calls/);
  });

  it('returns text without tool_calls if model emits content first', async () => {
    createMock.mockResolvedValueOnce({
      choices: [{ message: { content: 'no tools needed' } }],
    });

    const out = await chatComplete({
      system: 'sys',
      user: 'u',
      tools: {
        schema: [
          {
            type: 'function',
            function: {
              name: 'get_instance',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
        onToolCall: vi.fn(),
      },
    });
    expect(out.text).toBe('no tools needed');
    expect(out.toolUseIterations).toBe(0);
  });
});
