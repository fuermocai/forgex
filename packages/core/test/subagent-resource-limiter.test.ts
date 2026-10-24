/**
 * ResourceLimiter 单元测试（v0.3.0 Phase 2）。
 */
import { describe, expect, it } from 'vitest';
import { ForgeError } from '@forgex/shared';
import { ResourceLimiter } from '../src/subagent/resource-limiter.js';
import { resolveBudget } from '../src/subagent/types.js';

describe('ResourceLimiter 基础消耗记录', () => {
  it('初始状态为零消耗', () => {
    const limiter = new ResourceLimiter(resolveBudget());
    const snap = limiter.snapshot();
    expect(snap.tokensUsed).toBe(0);
    expect(snap.toolCallsUsed).toBe(0);
    expect(snap.iterationsUsed).toBe(0);
    expect(snap.exceeded).toBe(false);
    expect(snap.exceededReason).toBeUndefined();
  });

  it('recordTokens 正确累计', () => {
    const limiter = new ResourceLimiter(resolveBudget({ maxTokens: 10000 }));
    limiter.recordTokens(100);
    limiter.recordTokens(250);
    limiter.recordTokens(50);
    expect(limiter.snapshot().tokensUsed).toBe(400);
    expect(limiter.isExceeded()).toBe(false);
  });

  it('recordToolCall 正确累计', () => {
    const limiter = new ResourceLimiter(resolveBudget({ maxToolCalls: 10 }));
    limiter.recordToolCall();
    limiter.recordToolCall();
    limiter.recordToolCall();
    expect(limiter.snapshot().toolCallsUsed).toBe(3);
  });

  it('recordIteration 正确累计', () => {
    const limiter = new ResourceLimiter(resolveBudget({ maxIterations: 5 }));
    limiter.recordIteration();
    limiter.recordIteration();
    expect(limiter.snapshot().iterationsUsed).toBe(2);
  });

  it('负数 token 消耗被忽略', () => {
    const limiter = new ResourceLimiter(resolveBudget());
    limiter.recordTokens(-100);
    limiter.recordTokens(50);
    expect(limiter.snapshot().tokensUsed).toBe(50);
  });
});

describe('ResourceLimiter 预算超限', () => {
  it('token 超预算 → isExceeded=true + 包含原因', () => {
    const limiter = new ResourceLimiter(resolveBudget({ maxTokens: 100 }));
    limiter.recordTokens(50);
    expect(limiter.isExceeded()).toBe(false);
    limiter.recordTokens(60); // 110 > 100
    expect(limiter.isExceeded()).toBe(true);
    expect(limiter.getExceededReason()).toContain('token');
    expect(limiter.getExceededReason()).toContain('100');
  });

  it('工具调用超预算', () => {
    const limiter = new ResourceLimiter(resolveBudget({ maxToolCalls: 2 }));
    limiter.recordToolCall();
    limiter.recordToolCall();
    expect(limiter.isExceeded()).toBe(false);
    limiter.recordToolCall(); // 3 > 2
    expect(limiter.isExceeded()).toBe(true);
    expect(limiter.getExceededReason()).toContain('工具调用');
  });

  it('迭代次数超预算', () => {
    const limiter = new ResourceLimiter(resolveBudget({ maxIterations: 2 }));
    limiter.recordIteration();
    limiter.recordIteration();
    expect(limiter.isExceeded()).toBe(false);
    limiter.recordIteration();
    expect(limiter.isExceeded()).toBe(true);
    expect(limiter.getExceededReason()).toContain('迭代');
  });

  it('超预算后继续记录不会重复覆盖原因', () => {
    const limiter = new ResourceLimiter(resolveBudget({ maxTokens: 100, maxToolCalls: 1000 }));
    limiter.recordTokens(200); // token 超预算
    const firstReason = limiter.getExceededReason();
    limiter.recordToolCall();
    limiter.recordToolCall(); // 即使工具再超，原因仍是第一个
    expect(limiter.getExceededReason()).toBe(firstReason);
  });
});

describe('ResourceLimiter assertWithinBudget', () => {
  it('未超预算时不抛异常', () => {
    const limiter = new ResourceLimiter(resolveBudget({ maxTokens: 1000 }));
    limiter.recordTokens(500);
    expect(() => limiter.assertWithinBudget()).not.toThrow();
  });

  it('超预算时抛 SUBAGENT_BUDGET_EXCEEDED', () => {
    const limiter = new ResourceLimiter(resolveBudget({ maxTokens: 100 }));
    limiter.recordTokens(200);
    let caught: unknown;
    try {
      limiter.assertWithinBudget();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ForgeError);
    expect((caught as ForgeError).code).toBe('SUBAGENT_BUDGET_EXCEEDED');
  });

  it('抛出的 ForgeError 包含 details.snapshot', () => {
    const limiter = new ResourceLimiter(resolveBudget({ maxTokens: 50 }));
    limiter.recordTokens(100);
    let caught: ForgeError | undefined;
    try {
      limiter.assertWithinBudget();
    } catch (err) {
      caught = err as ForgeError;
    }
    expect(caught?.details).toBeDefined();
    expect(caught?.details?.snapshot).toBeDefined();
    expect(caught?.details?.budget).toBeDefined();
  });
});

describe('ResourceLimiter forceExceeded', () => {
  it('强制标记超预算', () => {
    const limiter = new ResourceLimiter(resolveBudget());
    expect(limiter.isExceeded()).toBe(false);
    limiter.forceExceeded('外部检测到异常');
    expect(limiter.isExceeded()).toBe(true);
    expect(limiter.getExceededReason()).toBe('外部检测到异常');
  });

  it('forceExceeded 后 assertWithinBudget 抛异常', () => {
    const limiter = new ResourceLimiter(resolveBudget());
    limiter.forceExceeded('测试强制超限');
    expect(() => limiter.assertWithinBudget()).toThrow();
  });

  it('重复 forceExceeded 只保留第一次原因', () => {
    const limiter = new ResourceLimiter(resolveBudget());
    limiter.forceExceeded('第一次');
    limiter.forceExceeded('第二次');
    expect(limiter.getExceededReason()).toBe('第一次');
  });
});

describe('ResourceLimiter snapshot', () => {
  it('durationMs 随时间递增', async () => {
    const limiter = new ResourceLimiter(resolveBudget());
    const snap1 = limiter.snapshot();
    // 等 5ms
    await new Promise((resolve) => setTimeout(resolve, 5));
    const snap2 = limiter.snapshot();
    expect(snap2.durationMs).toBeGreaterThanOrEqual(snap1.durationMs);
  });

  it('exceeded=true 时 snapshot 包含 exceededReason', () => {
    const limiter = new ResourceLimiter(resolveBudget({ maxTokens: 10 }));
    limiter.recordTokens(20);
    const snap = limiter.snapshot();
    expect(snap.exceeded).toBe(true);
    expect(snap.exceededReason).toBeTruthy();
  });

  it('exceeded=false 时 snapshot 不包含 exceededReason 字段', () => {
    const limiter = new ResourceLimiter(resolveBudget());
    const snap = limiter.snapshot();
    expect(snap.exceeded).toBe(false);
    expect('exceededReason' in snap).toBe(false);
  });
});
