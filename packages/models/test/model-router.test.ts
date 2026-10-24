/**
 * ModelRouter 测试（v0.5.0 Phase 5）。
 */
import { describe, it, expect } from 'vitest';
import { ModelRouter } from '../src/model-router.js';
import type { ModelProvider } from '../src/types.js';

function makeMockProvider(name: string): ModelProvider {
  return {
    name,
    config: { baseUrl: '', model: name, contextWindow: 8000, maxOutputTokens: 2000, temperature: 0, timeoutMs: 30000, maxRetries: 2, stream: false },
    async chat() {
      return { message: { role: 'assistant', content: 'ok' }, finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, streamed: false };
    },
  };
}

describe('ModelRouter', () => {
  it('按能力选择', () => {
    const router = new ModelRouter();
    router.register({ id: 'deepseek-v3', provider: makeMockProvider('ds-v3'), capabilities: ['reasoning', 'coding'], tier: 2 });
    router.register({ id: 'qwen-turbo', provider: makeMockProvider('qwen-turbo'), capabilities: ['fast', 'cheap', 'chat'], tier: 1 });

    const p = router.select({ requiredCapabilities: ['coding'] });
    expect(p.name).toBe('ds-v3');
  });

  it('capability 不匹配抛 MODEL_CAPABILITY_MISMATCH', () => {
    const router = new ModelRouter();
    router.register({ id: 'cheap', provider: makeMockProvider('cheap'), capabilities: ['cheap', 'chat'], tier: 1 });

    let err: any = null;
    try { router.select({ requiredCapabilities: ['vision'] }); } catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(err.code).toBe('MODEL_CAPABILITY_MISMATCH');
  });

  it('tier 过滤', () => {
    const router = new ModelRouter();
    router.register({ id: 'expensive', provider: makeMockProvider('e'), capabilities: ['chat'], tier: 5 });
    router.register({ id: 'cheap', provider: makeMockProvider('c'), capabilities: ['chat'], tier: 1 });

    const p = router.select({ requiredCapabilities: ['chat'], maxTier: 2 });
    expect(p.name).toBe('c');
  });

  it('按健康度降级：健康模型优先', () => {
    const router = new ModelRouter();
    router.register({ id: 'primary', provider: makeMockProvider('p'), capabilities: ['chat'], tier: 2 });
    router.register({ id: 'backup', provider: makeMockProvider('b'), capabilities: ['chat'], tier: 2 });

    router.markFailed('primary');
    router.markFailed('primary');

    const p = router.select({ requiredCapabilities: ['chat'] });
    expect(p.name).toBe('b');
  });

  it('executeWithFallback 主失败自动回退', async () => {
    const router = new ModelRouter();
    router.register({ id: 'primary', provider: makeMockProvider('p'), capabilities: ['chat'], tier: 2 });
    router.register({ id: 'backup', provider: makeMockProvider('b'), capabilities: ['chat'], tier: 3 });

    let callCount = 0;
    const result = await router.executeWithFallback({ requiredCapabilities: ['chat'] }, async (provider) => {
      callCount++;
      if (provider.name === 'p') throw new Error('主模型挂了');
      return 'success';
    });
    expect(result).toBe('success');
    expect(callCount).toBe(2);
  });

  it('executeWithFallback 全失败 → MODEL_FALLBACK_EXHAUSTED', async () => {
    const router = new ModelRouter();
    router.register({ id: 'a', provider: makeMockProvider('a'), capabilities: ['chat'], tier: 1 });
    router.register({ id: 'b', provider: makeMockProvider('b'), capabilities: ['chat'], tier: 2 });

    let err: any = null;
    try {
      await router.executeWithFallback({ requiredCapabilities: ['chat'] }, async () => {
        throw new Error('全挂');
      });
    } catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(err.code).toBe('MODEL_FALLBACK_EXHAUSTED');
  });

  it('listModels 返回已注册列表', () => {
    const router = new ModelRouter();
    router.register({ id: 'm1', provider: makeMockProvider('m1'), capabilities: ['chat'], tier: 1 });
    router.register({ id: 'm2', provider: makeMockProvider('m2'), capabilities: ['coding'], tier: 2 });
    expect(router.listModels().sort()).toEqual(['m1', 'm2']);
  });
});
