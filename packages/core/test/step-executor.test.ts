/**
 * StepExecutor 回归测试（v0.3.0 Phase 6 补充）。
 *
 * 背景：Benchmark REC-01/02 发现重试路径曾走 running → ready 的非法状态转移，
 * 导致任何 max_attempts > 1 的步骤在首次失败后直接失败。
 * 本文件锁住修复后的合法转移路径：
 *   pending → ready → running → completed / failed → ready → running → ...
 */

import { describe, expect, it } from 'vitest';
import { PlanManager } from '../src/planning/plan-manager.js';
import { StepExecutor } from '../src/planning/step-executor.js';
import { createStep } from '../src/planning/types.js';
import type { LoopResult } from '../src/agent/agent-loop.js';

/** 最小合法 LoopResult */
function okResult(text: string): LoopResult {
  return {
    sessionId: 'test',
    reason: 'completed',
    text,
    toolCalls: 1,
    iterations: 1,
    metrics: {
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      toolCalls: 1,
      toolMs: 0,
      modelMs: 0,
      durationMs: 0,
      iterations: 1,
    },
  } as LoopResult;
}

function makePlan(mgr: PlanManager, maxAttempts?: number) {
  const step = createStep({
    task_id: 't',
    description: '测试步骤',
    ...(maxAttempts !== undefined ? { max_attempts: maxAttempts } : {}),
  });
  return mgr.createPlan({ user_request: '测试请求', steps: [step] });
}

describe('StepExecutor 状态机合规性', () => {
  it('pending 步骤直接执行：自动推进 ready 并成功完成', async () => {
    const mgr = new PlanManager();
    const plan = makePlan(mgr);
    const executor = new StepExecutor({
      planManager: mgr,
      agent: { run: async () => okResult('done') },
    });
    const result = await executor.executeStep(plan.plan_id, plan.steps[0]!.step_id);
    expect(result.final_status).toBe('completed');
    expect(result.attemptsUsed).toBe(1);
    expect(mgr.getPlan(plan.plan_id).steps[0]!.status).toBe('completed');
  });

  it('首次失败第二次成功：重试走 failed → ready → running 合法转移', async () => {
    const mgr = new PlanManager();
    const plan = makePlan(mgr, 3);
    let calls = 0;
    const executor = new StepExecutor({
      planManager: mgr,
      agent: {
        run: async () => {
          calls += 1;
          if (calls === 1) throw new Error('首次失败');
          return okResult('恢复成功');
        },
      },
    });
    const result = await executor.executeStep(plan.plan_id, plan.steps[0]!.step_id);
    expect(result.final_status).toBe('completed');
    expect(result.attemptsUsed).toBe(2);
    expect(calls).toBe(2);
  });

  it('重试预算耗尽：final_status=failed 且 attemptsUsed=max_attempts', async () => {
    const mgr = new PlanManager();
    const plan = makePlan(mgr, 2);
    let calls = 0;
    const executor = new StepExecutor({
      planManager: mgr,
      agent: {
        run: async () => {
          calls += 1;
          throw new Error('持续失败');
        },
      },
    });
    const result = await executor.executeStep(plan.plan_id, plan.steps[0]!.step_id);
    expect(result.final_status).toBe('failed');
    expect(result.attemptsUsed).toBe(2);
    expect(calls).toBe(2);
    const step = mgr.getPlan(plan.plan_id).steps[0]!;
    expect(step.status).toBe('failed');
    expect(step.attempts).toBe(2); // 每次失败尝试都应累加
  });

  it('globalMaxAttempts 收紧 step.max_attempts', async () => {
    const mgr = new PlanManager();
    const plan = makePlan(mgr, 5);
    let calls = 0;
    const executor = new StepExecutor({
      planManager: mgr,
      globalMaxAttempts: 1,
      agent: {
        run: async () => {
          calls += 1;
          throw new Error('失败');
        },
      },
    });
    const result = await executor.executeStep(plan.plan_id, plan.steps[0]!.step_id);
    expect(result.final_status).toBe('failed');
    expect(result.attemptsUsed).toBe(1);
    expect(calls).toBe(1);
  });

  it('执行前已取消：不调用 agent，步骤进入 cancelled', async () => {
    const mgr = new PlanManager();
    const plan = makePlan(mgr);
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const executor = new StepExecutor({
      planManager: mgr,
      signal: controller.signal,
      agent: {
        run: async () => {
          calls += 1;
          return okResult('不应到达');
        },
      },
    });
    const result = await executor.executeStep(plan.plan_id, plan.steps[0]!.step_id);
    expect(result.final_status).toBe('cancelled');
    expect(result.cancelled).toBe(true);
    expect(calls).toBe(0);
    expect(mgr.getPlan(plan.plan_id).steps[0]!.status).toBe('cancelled');
  });

  it('未注入 agent：按失败处理且走完整重试预算', async () => {
    const mgr = new PlanManager();
    const plan = makePlan(mgr, 2);
    const executor = new StepExecutor({ planManager: mgr });
    const result = await executor.executeStep(plan.plan_id, plan.steps[0]!.step_id);
    expect(result.final_status).toBe('failed');
    expect(result.attemptsUsed).toBe(2);
    expect(result.execution_result?.failureReason).toContain('未注入 agent');
  });

  it('step_id 不存在：直接返回 failed，不抛异常', async () => {
    const mgr = new PlanManager();
    const plan = makePlan(mgr);
    const executor = new StepExecutor({ planManager: mgr });
    const result = await executor.executeStep(plan.plan_id, 'step_not_exists');
    expect(result.final_status).toBe('failed');
    expect(result.attemptsUsed).toBe(0);
  });
});
