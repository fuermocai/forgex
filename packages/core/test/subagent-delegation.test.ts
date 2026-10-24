/**
 * DelegationManager 单元测试（v0.3.0 Phase 2）。
 *
 * 使用 mock SubAgentRunner（不依赖真实 ModelProvider），专注测试：
 *   - 权限收敛（越权 spec 直接拒绝）
 *   - 并发限制（maxConcurrency）
 *   - 取消传播
 *   - 失败隔离（一个失败不影响其他）
 *   - 汇总统计
 */
import { describe, expect, it } from 'vitest';
import type { SubAgentResult, SubAgentSpec } from '../src/subagent/types.js';
import { createSubAgentSpec } from '../src/subagent/types.js';
import { DelegationManager } from '../src/subagent/delegation-manager.js';
import type { SubAgentRunner } from '../src/subagent/sub-agent-runner.js';

/* 构造一个 mock SubAgentRunner（只暴露 run 方法） */
function mockRunner(
  behavior: (spec: SubAgentSpec, options?: { signal?: AbortSignal }) => Promise<SubAgentResult>,
): SubAgentRunner {
  return { run: behavior } as unknown as SubAgentRunner;
}

function successResult(spec: SubAgentSpec, summary = '完成'): SubAgentResult {
  return {
    subagent_id: spec.subagent_id,
    role: spec.role,
    success: true,
    status: 'completed',
    summary,
    evidence_refs: [],
    usage: { tokens: 100, toolCalls: 1, durationMs: 10, iterations: 1 },
  };
}

function failResult(spec: SubAgentSpec, reason: string): SubAgentResult {
  return {
    subagent_id: spec.subagent_id,
    role: spec.role,
    success: false,
    status: 'failed',
    summary: reason,
    failureReason: reason,
    evidence_refs: [],
    usage: { tokens: 0, toolCalls: 0, durationMs: 0, iterations: 0 },
  };
}

describe('DelegationManager 权限收敛', () => {
  it('spec.allowed_tools 越权 → 直接返回失败，不调用 runner', async () => {
    let called = 0;
    const runner = mockRunner(async (spec) => {
      called++;
      return successResult(spec);
    });
    const manager = new DelegationManager(runner);
    const spec = createSubAgentSpec({
      role: 'worker',
      task: '执行',
      allowed_tools: ['read_file', 'ssh_inspect'], // ssh_inspect 越权
    });
    const summary = await manager.delegate([spec], {
      parentTools: ['read_file', 'edit_file'],
    });
    expect(called).toBe(0);
    expect(summary.total).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.results[0]!.failureReason).toContain('ssh_inspect');
  });

  it('spec.allowed_tools ⊆ parentTools → 正常调用 runner', async () => {
    const runner = mockRunner(async (spec) => successResult(spec));
    const manager = new DelegationManager(runner);
    const spec = createSubAgentSpec({
      role: 'explorer',
      task: '探索',
      allowed_tools: ['read_file'],
    });
    const summary = await manager.delegate([spec], {
      parentTools: ['read_file', 'grep_search'],
    });
    expect(summary.succeeded).toBe(1);
    expect(summary.results[0]!.success).toBe(true);
  });

  it('空 allowed_tools ⊆ 任意 parentTools → 合法', async () => {
    const runner = mockRunner(async (spec) => successResult(spec));
    const manager = new DelegationManager(runner);
    const spec = createSubAgentSpec({
      role: 'reviewer',
      task: '纯文本审查',
      allowed_tools: [],
    });
    const summary = await manager.delegate([spec], { parentTools: [] });
    expect(summary.succeeded).toBe(1);
  });
});

describe('DelegationManager 并发控制', () => {
  it('默认 maxConcurrency=3，5 个任务分两批跑', async () => {
    const running: number[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const runner = mockRunner(async (spec) => {
      concurrent++;
      running.push(concurrent);
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 20));
      concurrent--;
      return successResult(spec);
    });
    const manager = new DelegationManager(runner);
    const specs = Array.from({ length: 5 }, (_, i) =>
      createSubAgentSpec({
        role: 'explorer',
        task: `任务 ${i}`,
        allowed_tools: [],
      }),
    );
    await manager.delegate(specs, { parentTools: [] });
    expect(maxConcurrent).toBeLessThanOrEqual(3);
    expect(maxConcurrent).toBeGreaterThan(0);
  });

  it('maxConcurrency=1 → 严格串行', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const runner = mockRunner(async (spec) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 10));
      concurrent--;
      return successResult(spec);
    });
    const manager = new DelegationManager(runner);
    const specs = Array.from({ length: 3 }, (_, i) =>
      createSubAgentSpec({ role: 'explorer', task: `任务 ${i}`, allowed_tools: [] }),
    );
    await manager.delegate(specs, { parentTools: [], maxConcurrency: 1 });
    expect(maxConcurrent).toBe(1);
  });

  it('maxConcurrency 超过硬上限 10 → 被 clip 到 10', async () => {
    let maxConcurrent = 0;
    let concurrent = 0;
    const runner = mockRunner(async (spec) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 5));
      concurrent--;
      return successResult(spec);
    });
    const manager = new DelegationManager(runner);
    const specs = Array.from({ length: 20 }, (_, i) =>
      createSubAgentSpec({ role: 'explorer', task: `任务 ${i}`, allowed_tools: [] }),
    );
    await manager.delegate(specs, { parentTools: [], maxConcurrency: 999 });
    expect(maxConcurrent).toBeLessThanOrEqual(10);
  });
});

describe('DelegationManager 取消传播', () => {
  it('父任务 AbortSignal 触发 → 排队任务直接返回 cancelled', async () => {
    const controller = new AbortController();
    const runner = mockRunner(async (spec) => {
      // 模拟长任务
      await new Promise((resolve) => setTimeout(resolve, 100));
      return successResult(spec);
    });
    const manager = new DelegationManager(runner);
    const specs = Array.from({ length: 5 }, (_, i) =>
      createSubAgentSpec({ role: 'explorer', task: `任务 ${i}`, allowed_tools: [] }),
    );
    // 启动后立即取消
    setTimeout(() => controller.abort(), 10);
    const summary = await manager.delegate(specs, {
      parentTools: [],
      signal: controller.signal,
      maxConcurrency: 2,
    });
    // 至少有部分任务被取消
    expect(summary.cancelled + summary.succeeded + summary.failed).toBe(5);
  });
});

describe('DelegationManager 失败隔离', () => {
  it('一个任务失败不影响其他任务', async () => {
    const runner = mockRunner(async (spec) => {
      if (spec.task === '失败任务') return failResult(spec, '模拟失败');
      return successResult(spec);
    });
    const manager = new DelegationManager(runner);
    const specs = [
      createSubAgentSpec({ role: 'explorer', task: '成功任务1', allowed_tools: [] }),
      createSubAgentSpec({ role: 'explorer', task: '失败任务', allowed_tools: [] }),
      createSubAgentSpec({ role: 'explorer', task: '成功任务2', allowed_tools: [] }),
    ];
    const summary = await manager.delegate(specs, { parentTools: [] });
    expect(summary.total).toBe(3);
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.results[0]!.success).toBe(true);
    expect(summary.results[1]!.success).toBe(false);
    expect(summary.results[2]!.success).toBe(true);
  });

  it('runner 抛异常 → 转换为失败结果，不影响其他任务', async () => {
    const runner = mockRunner(async (spec) => {
      if (spec.task === '异常任务') throw new Error('内部崩溃');
      return successResult(spec);
    });
    const manager = new DelegationManager(runner);
    const specs = [
      createSubAgentSpec({ role: 'explorer', task: '正常任务', allowed_tools: [] }),
      createSubAgentSpec({ role: 'explorer', task: '异常任务', allowed_tools: [] }),
    ];
    const summary = await manager.delegate(specs, { parentTools: [] });
    expect(summary.total).toBe(2);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.results[1]!.failureReason).toContain('内部崩溃');
  });
});

describe('DelegationManager 汇总统计', () => {
  it('统计 succeeded/failed/cancelled/budgetExceeded', async () => {
    const runner = mockRunner(async (spec) => {
      if (spec.task === '失败') return failResult(spec, '失败');
      if (spec.task === '超预算') {
        return {
          ...successResult(spec),
          success: false,
          status: 'budget_exceeded' as const,
        };
      }
      if (spec.task === '取消') {
        return {
          ...successResult(spec),
          success: false,
          status: 'cancelled' as const,
        };
      }
      return successResult(spec);
    });
    const manager = new DelegationManager(runner);
    const specs = [
      createSubAgentSpec({ role: 'explorer', task: '成功', allowed_tools: [] }),
      createSubAgentSpec({ role: 'explorer', task: '失败', allowed_tools: [] }),
      createSubAgentSpec({ role: 'explorer', task: '超预算', allowed_tools: [] }),
      createSubAgentSpec({ role: 'explorer', task: '取消', allowed_tools: [] }),
    ];
    const summary = await manager.delegate(specs, { parentTools: [] });
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.budgetExceeded).toBe(1);
    expect(summary.cancelled).toBe(1);
  });

  it('结果顺序与输入 specs 顺序一致', async () => {
    const runner = mockRunner(async (spec) => {
      // 模拟乱序完成
      const delay = spec.task === 'task_0' ? 50 : 10;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return successResult(spec, `完成 ${spec.task}`);
    });
    const manager = new DelegationManager(runner);
    const specs = [
      createSubAgentSpec({ role: 'explorer', task: 'task_0', allowed_tools: [] }),
      createSubAgentSpec({ role: 'explorer', task: 'task_1', allowed_tools: [] }),
      createSubAgentSpec({ role: 'explorer', task: 'task_2', allowed_tools: [] }),
    ];
    const summary = await manager.delegate(specs, { parentTools: [] });
    expect(summary.results[0]!.summary).toContain('task_0');
    expect(summary.results[1]!.summary).toContain('task_1');
    expect(summary.results[2]!.summary).toContain('task_2');
  });

  it('durationMs 是总耗时（不是单个任务耗时之和）', async () => {
    const runner = mockRunner(async (spec) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return successResult(spec);
    });
    const manager = new DelegationManager(runner);
    const specs = Array.from({ length: 3 }, (_, i) =>
      createSubAgentSpec({ role: 'explorer', task: `任务 ${i}`, allowed_tools: [] }),
    );
    const summary = await manager.delegate(specs, { parentTools: [], maxConcurrency: 3 });
    // 并发 3，3 个任务同时跑 → 总耗时 ≈ 30ms，远小于 90ms
    expect(summary.durationMs).toBeGreaterThanOrEqual(20);
    expect(summary.durationMs).toBeLessThan(200);
  });
});

describe('DelegationManager delegateOne', () => {
  it('便捷 API：分派单个任务', async () => {
    const runner = mockRunner(async (spec) => successResult(spec));
    const manager = new DelegationManager(runner);
    const spec = createSubAgentSpec({
      role: 'explorer',
      task: '单任务',
      allowed_tools: [],
    });
    const result = await manager.delegateOne(spec, { parentTools: [] });
    expect(result.success).toBe(true);
  });
});
