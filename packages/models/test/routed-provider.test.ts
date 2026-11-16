import { describe, expect, it } from 'vitest';
import { ModelRouter } from '../src/model-router.js';
import { RoutedModelProvider } from '../src/routed-provider.js';
import type { ModelProvider } from '../src/types.js';

function provider(name: string, behavior?: () => Promise<void>): ModelProvider {
  return {
    name,
    config: {
      baseUrl: `https://${name}.example/v1`, model: name, contextWindow: 8192,
      maxOutputTokens: 2048, temperature: 0, timeoutMs: 1000, maxRetries: 0, stream: false,
    },
    async chat() {
      await behavior?.();
      return {
        message: { role: 'assistant', content: name }, finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, streamed: false,
      };
    },
  };
}

describe('RoutedModelProvider', () => {
  it('uses the selected role and reports the actual fallback model', async () => {
    const router = new ModelRouter();
    router.register({ id: 'primary', provider: provider('primary', async () => { throw new Error('temporary outage'); }), capabilities: ['chat', 'coding'], tier: 1, available: true });
    router.register({ id: 'backup', provider: provider('backup'), capabilities: ['chat', 'coding'], tier: 2, available: true });
    const routed = new RoutedModelProvider(router, { coding: 'primary', default: 'primary' });
    routed.setModelRole('coding');

    const response = await routed.chat({ messages: [{ role: 'user', content: 'implement this' }] });

    expect(response.message.content).toBe('backup');
    expect(response.modelId).toBe('backup');
    expect(response.modelName).toBe('backup');
    expect(response.fallbackReason).toContain('temporary outage');
    expect(routed.currentModelRole).toBe('coding');
  });

  it('routes requests through the configured role model', async () => {
    const router = new ModelRouter();
    router.register({ id: 'cheap-model', provider: provider('cheap-model'), capabilities: ['chat', 'cheap'], tier: 1, available: true, costTier: 1 });
    router.register({ id: 'reasoning-model', provider: provider('reasoning-model'), capabilities: ['chat', 'reasoning'], tier: 2, available: true });
    const routed = new RoutedModelProvider(router, { cheap: 'cheap-model', reasoning: 'reasoning-model', default: 'reasoning-model' });
    routed.setModelRole('cheap');

    const response = await routed.chat({ messages: [{ role: 'user', content: 'quick answer' }] });

    expect(response.modelId).toBe('cheap-model');
    expect(routed.currentModelId).toBe('cheap-model');
  });
});
