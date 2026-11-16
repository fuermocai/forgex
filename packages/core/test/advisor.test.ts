import { describe, expect, it, vi } from 'vitest';
import type { ChatRequest, ChatResponse, ModelProvider } from '@forgex/models';
import { Advisor } from '../src/agent/advisor.js';

function provider(reply: string | Promise<string>): ModelProvider {
  return {
    name: 'advisor-test',
    config: {
      baseUrl: 'http://127.0.0.1/v1', model: 'advisor-test', contextWindow: 8192,
      maxOutputTokens: 256, temperature: 0, timeoutMs: 1000, maxRetries: 0, stream: false,
    },
    chat: vi.fn(async (_request: ChatRequest): Promise<ChatResponse> => ({
      message: { role: 'assistant', content: await reply },
      finishReason: 'stop',
      usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 },
      streamed: false,
    })),
  };
}

describe('Advisor', () => {
  it('timeout warns and continues', async () => {
    const model = provider(new Promise<string>(() => {}));
    const advisor = new Advisor({
      provider: model, enabled: true, stages: ['tools'], timeoutMs: 5,
      maxChecksPerTurn: 4, maxInterventionsPerTurn: 1,
    });

    const review = await advisor.review('tools', { tool: 'run_command' });

    expect(review.verdict).toBe('warn');
    expect(review.reason).toMatch(/timeout/i);
    expect(model.chat).toHaveBeenCalledOnce();
  });

  it('cannot run more than configured checks', async () => {
    const model = provider(JSON.stringify({ verdict: 'allow', reason: 'ok' }));
    const advisor = new Advisor({
      provider: model, enabled: true, stages: ['plan', 'tools'], timeoutMs: 100,
      maxChecksPerTurn: 1, maxInterventionsPerTurn: 1,
    });

    expect((await advisor.review('plan', {})).verdict).toBe('allow');
    expect((await advisor.review('tools', {})).verdict).toBe('allow');
    expect(model.chat).toHaveBeenCalledOnce();
  });

  it('limits repeated interventions within a turn', async () => {
    const model = provider(JSON.stringify({ verdict: 'warn', reason: 'uncertain' }));
    const advisor = new Advisor({
      provider: model, enabled: true, stages: ['tools', 'final'], timeoutMs: 100,
      maxChecksPerTurn: 4, maxInterventionsPerTurn: 1,
    });

    expect((await advisor.review('tools', {})).verdict).toBe('warn');
    const second = await advisor.review('final', {});

    expect(second.verdict).toBe('allow');
    expect(second.reason).toMatch(/intervention limit/i);
    expect(model.chat).toHaveBeenCalledTimes(2);
  });
});
