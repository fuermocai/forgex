import { describe, expect, it, vi } from 'vitest';
import type { ChatRequest, ChatResponse, ModelProvider } from '@forgex/models';
import type { ToolCall } from '@forgex/shared';
import { Advisor } from '../src/agent/advisor.js';
import { AgentLoop } from '../src/agent/agent-loop.js';
import { ContextManager } from '../src/context/context-manager.js';
import { EventBus } from '../src/events/event-bus.js';
import { MetricsCollector } from '../src/runtime/metrics.js';
import type { ToolDispatcher } from '../src/runtime/tool-dispatcher.js';

function testProvider(reply: ChatResponse | Promise<ChatResponse>): ModelProvider {
  return {
    name: 'test',
    config: {
      baseUrl: 'http://127.0.0.1/v1', model: 'test', contextWindow: 8192,
      maxOutputTokens: 256, temperature: 0, timeoutMs: 1000, maxRetries: 0, stream: false,
    },
    chat: vi.fn(async (_request: ChatRequest) => await reply),
  };
}

describe('AgentLoop Advisor integration', () => {
  it('advisor block prevents the associated tool call', async () => {
    const toolCall: ToolCall = {
      id: 'call-1', type: 'function', function: { name: 'run_command', arguments: '{"command":"rm -rf /"}' },
    };
    const provider = testProvider({
      message: { role: 'assistant', content: null, tool_calls: [toolCall] },
      finishReason: 'tool_calls',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, streamed: false,
    });
    const advisor = new Advisor({
      provider: testProvider({
        message: { role: 'assistant', content: JSON.stringify({ verdict: 'block', reason: 'destructive command' }) },
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, streamed: false,
      }),
      enabled: true, stages: ['tools'], timeoutMs: 100, maxChecksPerTurn: 4, maxInterventionsPerTurn: 1,
    });
    const dispatcher = { executeMany: vi.fn(async () => []) } as unknown as ToolDispatcher;
    const events = new EventBus();
    const emitted: unknown[] = [];
    events.on((event) => emitted.push(event));
    const loop = new AgentLoop({
      provider,
      registry: { specs: () => [] } as never,
      dispatcher,
      context: new ContextManager({ systemPrompt: 'test', contextWindow: 8192, maxOutputTokens: 256 }),
      events,
      sessionId: 'session-test',
      advisor,
    });

    const result = await loop.run('remove system files', { signal: new AbortController().signal, metrics: new MetricsCollector('session-test') });

    expect(dispatcher.executeMany).not.toHaveBeenCalled();
    expect(result.reason).toBe('error');
    expect(result.error?.code).toBe('ADVISOR_BLOCKED');
    expect(emitted).toContainEqual(expect.objectContaining({ type: 'advisor:review', stage: 'tools', verdict: 'block' }));
  });

  it('does not expose final content until the final review allows it', async () => {
    const provider = testProvider({
      message: { role: 'assistant', content: 'unreviewed answer' },
      finishReason: 'stop',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, streamed: false,
    });
    const advisor = new Advisor({
      provider: testProvider({
        message: { role: 'assistant', content: JSON.stringify({ verdict: 'block', reason: 'unsupported claim' }) },
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, streamed: false,
      }),
      enabled: true, stages: ['final'], timeoutMs: 100, maxChecksPerTurn: 4, maxInterventionsPerTurn: 1,
    });
    const events = new EventBus();
    const emitted: unknown[] = [];
    events.on((event) => emitted.push(event));
    const loop = new AgentLoop({
      provider,
      registry: { specs: () => [] } as never,
      dispatcher: { executeMany: vi.fn(async () => []) } as unknown as ToolDispatcher,
      context: new ContextManager({ systemPrompt: 'test', contextWindow: 8192, maxOutputTokens: 256 }),
      events,
      sessionId: 'session-final',
      advisor,
    });

    const result = await loop.run('answer this', { signal: new AbortController().signal, metrics: new MetricsCollector('session-final') });

    expect(result.text).toBe('');
    expect(result.error?.code).toBe('ADVISOR_BLOCKED');
    expect(emitted).not.toContainEqual(expect.objectContaining({ type: 'assistant:message', text: 'unreviewed answer' }));
    expect(emitted).not.toContainEqual(expect.objectContaining({ type: 'assistant:delta', text: 'unreviewed answer' }));
  });
});
