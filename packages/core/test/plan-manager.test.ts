/**
 * PlanManager 单元测试。
 *
 * 覆盖：
 *   1. detectCycle 环检测（自环 / 2 节点 / 3 节点 / 菱形 DAG 合法）
 *   2. findDanglingDependencies 悬空依赖检测
 *   3. createPlan 三项校验（自环 → 悬空 → 环）+ 入库
 *   4. updateStepStatus 状态合法性 + 整体计划状态重算
 *   5. cancelPlan 取消全部未完成步骤
 *   6. checkpoint 委托（不注入 checkpoint 也能正常工作）
 *   7. reshapePlan 重规划时已完成步骤保留
 */
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  createStep,
  newPlanId,
  type TaskPlan,
  type TaskStep,
} from '../src/planning/types.js';
import {
  PlanManager,
  detectCycle,
  findDanglingDependencies,
  findSelfLoops,
} from '../src/planning/plan-manager.js';
import { CheckpointManager } from '../src/planning/checkpoint.js';

/* ------------------------------------------------------------------ */
/* 辅助工具                                                             */
/* ------------------------------------------------------------------ */

function mkStep(taskId: string, desc: string, deps: string[] = [], risk: TaskStep['risk_level'] = 'read'): TaskStep {
  return createStep({ task_id: taskId, description: desc, dependencies: deps, risk_level: risk });
}

function buildPlanWithDeps(
  taskId: string,
  definitions: Array<{ desc: string; deps?: number[] }>,
): { planId: string; steps: TaskStep[] } {
  // 用下标做"依赖哪个步骤"的简写
  const steps = definitions.map((d, i) => mkStep(`${taskId}`, d.desc, [], 'read'));
  // 回填依赖（依赖 step_id 字符串）
  definitions.forEach((d, i) => {
    if (d.deps && d.deps.length > 0) {
      steps[i].dependencies = d.deps.map((idx) => steps[idx].step_id);
    }
  });
  return { planId: newPlanId(), steps };
}

/* ------------------------------------------------------------------ */
/* 环检测                                                               */
/* ------------------------------------------------------------------ */

describe('detectCycle', () => {
  it('单个独立步骤 → 无环', () => {
    const { steps } = buildPlanWithDeps('t', [{ desc: 'A' }]);
    expect(detectCycle(steps).hasCycle).toBe(false);
  });

  it('2 节点 DAG（A→B）→ 无环', () => {
    const { steps } = buildPlanWithDeps('t', [
      { desc: 'A' },
      { desc: 'B', deps: [0] },
    ]);
    expect(detectCycle(steps).hasCycle).toBe(false);
  });

  it('菱形 DAG（A→B, A→C, B→D, C→D）→ 无环（合法）', () => {
    const { steps } = buildPlanWithDeps('t', [
      { desc: 'A' },
      { desc: 'B', deps: [0] },
      { desc: 'C', deps: [0] },
      { desc: 'D', deps: [1, 2] },
    ]);
    const r = detectCycle(steps);
    expect(r.hasCycle).toBe(false);
  });

  it('2 节点环（A→B→A）→ 有环', () => {
    const steps: TaskStep[] = [mkStep('t', 'A'), mkStep('t', 'B')];
    steps[0].dependencies = [steps[1].step_id];
    steps[1].dependencies = [steps[0].step_id];
    const r = detectCycle(steps);
    expect(r.hasCycle).toBe(true);
    expect(r.cycle.length).toBeGreaterThanOrEqual(2);
  });

  it('3 节点环（A→B→C→A）→ 有环且路径包含全部三个', () => {
    const steps: TaskStep[] = [mkStep('t', 'A'), mkStep('t', 'B'), mkStep('t', 'C')];
    steps[0].dependencies = [steps[1].step_id];
    steps[1].dependencies = [steps[2].step_id];
    steps[2].dependencies = [steps[0].step_id];
    const r = detectCycle(steps);
    expect(r.hasCycle).toBe(true);
    const cycleSet = new Set(r.cycle);
    for (const s of steps) expect(cycleSet.has(s.step_id)).toBe(true);
  });

  it('自环 → hasCycle=true', () => {
    const s = mkStep('t', 'A');
    s.dependencies = [s.step_id];
    expect(detectCycle([s]).hasCycle).toBe(true);
  });

  it('大 DAG（10 步骤，多层依赖，无环）→ 无环', () => {
    const defs = [
      { desc: 'log1' },
      { desc: 'log2' },
      { desc: 'log3' },
      { desc: 'parse', deps: [0, 1] },
      { desc: 'correlate', deps: [2, 3] },
      { desc: 'explore', deps: [3] },
      { desc: 'git_analysis', deps: [4] },
      { desc: 'design_fix', deps: [5, 6] },
      { desc: 'apply', deps: [7] },
      { desc: 'verify', deps: [8] },
    ];
    const { steps } = buildPlanWithDeps('t', defs);
    expect(detectCycle(steps).hasCycle).toBe(false);
    expect(steps).toHaveLength(10);
  });
});

describe('findSelfLoops', () => {
  it('无自环 → 空数组', () => {
    const { steps } = buildPlanWithDeps('t', [{ desc: 'A' }, { desc: 'B', deps: [0] }]);
    expect(findSelfLoops(steps)).toEqual([]);
  });

  it('有自环 → 返回 step_id', () => {
    const s = mkStep('t', 'A');
    s.dependencies = [s.step_id];
    expect(findSelfLoops([s])).toEqual([s.step_id]);
  });
});

describe('findDanglingDependencies', () => {
  it('全部依赖都存在 → 空数组', () => {
    const { steps } = buildPlanWithDeps('t', [
      { desc: 'A' },
      { desc: 'B', deps: [0] },
    ]);
    expect(findDanglingDependencies(steps)).toEqual([]);
  });

  it('依赖不存在的 step_id → 返回悬空 ID', () => {
    const { steps } = buildPlanWithDeps('t', [{ desc: 'A' }]);
    steps[0].dependencies = ['nonexistent_step_id'];
    expect(findDanglingDependencies(steps)).toEqual(['nonexistent_step_id']);
  });

  it('混合存在+悬空 → 只返回悬空', () => {
    const { steps } = buildPlanWithDeps('t', [
      { desc: 'A' },
      { desc: 'B', deps: [0] },
    ]);
    steps[1].dependencies = [steps[0].step_id, 'ghost_1', 'ghost_2'];
    expect(findDanglingDependencies(steps).sort()).toEqual(['ghost_1', 'ghost_2']);
  });
});

/* ------------------------------------------------------------------ */
/* PlanManager - createPlan 三项校验                                    */
/* ------------------------------------------------------------------ */

function assertThrowsCode(fn: () => void, expectedCode: string): void {
  try {
    fn();
    throw new Error(`预期抛错 code=${expectedCode}，实际没抛`);
  } catch (e: any) {
    if (e?.code !== expectedCode) {
      throw new Error(`预期抛错 code=${expectedCode}，实际 code=${e?.code} message=${e?.message}`);
    }
  }
}

describe('PlanManager.createPlan 校验', () => {
  const mgr = new PlanManager();

  it('正常 DAG → 创建成功，status 自动折叠', () => {
    const { steps } = buildPlanWithDeps('t', [
      { desc: '读日志' },
      { desc: '分析根因', deps: [0] },
      { desc: '制定修复', deps: [1] },
    ]);
    const plan = mgr.createPlan({ user_request: '修 HTTP 500', steps });
    expect(plan.plan_id).toMatch(/^plan_/);
    expect(plan.status).toBe('pending');
    expect(plan.steps).toHaveLength(3);
    expect(plan.steps[0].status).toBe('pending');
    expect(mgr.listPlans()).toHaveLength(1);
  });

  it('空 user_request → PLANNING_PLAN_INVALID', () => {
    const { steps } = buildPlanWithDeps('t', [{ desc: 'A' }]);
    assertThrowsCode(() => mgr.createPlan({ user_request: '', steps }), 'PLANNING_PLAN_INVALID');
  });

  it('空 steps → PLANNING_PLAN_INVALID', () => {
    assertThrowsCode(() => mgr.createPlan({ user_request: 'A', steps: [] }), 'PLANNING_PLAN_INVALID');
  });

  it('自环 → PLANNING_DEPENDENCY_ERROR', () => {
    const s = mkStep('t', 'A');
    s.dependencies = [s.step_id];
    assertThrowsCode(() => mgr.createPlan({ user_request: 'X', steps: [s] }), 'PLANNING_DEPENDENCY_ERROR');
  });

  it('悬空依赖 → PLANNING_DEPENDENCY_ERROR', () => {
    const { steps } = buildPlanWithDeps('t', [{ desc: 'A' }]);
    steps[0].dependencies = ['ghost'];
    assertThrowsCode(() => mgr.createPlan({ user_request: 'X', steps }), 'PLANNING_DEPENDENCY_ERROR');
  });

  it('环 → PLANNING_DEPENDENCY_ERROR', () => {
    const { steps } = buildPlanWithDeps('t', [
      { desc: 'A', deps: [1] },
      { desc: 'B', deps: [0] },
    ]);
    assertThrowsCode(() => mgr.createPlan({ user_request: 'X', steps }), 'PLANNING_DEPENDENCY_ERROR');
  });

  it('菱形 DAG（合法）→ 创建成功', () => {
    const { steps } = buildPlanWithDeps('t', [
      { desc: 'A' },
      { desc: 'B', deps: [0] },
      { desc: 'C', deps: [0] },
      { desc: 'D', deps: [1, 2] },
    ]);
    const plan = mgr.createPlan({ user_request: 'X', steps });
    expect(plan.steps).toHaveLength(4);
  });
});

/* ------------------------------------------------------------------ */
/* updateStepStatus + 整体状态折叠                                       */
/* ------------------------------------------------------------------ */

describe('PlanManager.updateStepStatus', () => {
  function newPlan(stepsDefs: Array<{ desc: string; deps?: number[] }>): { mgr: PlanManager; plan: TaskPlan } {
    const mgr = new PlanManager();
    const { steps } = buildPlanWithDeps('t', stepsDefs);
    const plan = mgr.createPlan({ user_request: '测试', steps });
    return { mgr, plan };
  }

  it('pending → ready 合法', () => {
    const { mgr, plan } = newPlan([{ desc: 'A' }, { desc: 'B', deps: [0] }]);
    mgr.updateStepStatus(plan.plan_id, plan.steps[0].step_id, 'ready');
    expect(plan.steps[0].status).toBe('ready');
  });

  it('pending → running 非法 → 抛错', () => {
    const { mgr, plan } = newPlan([{ desc: 'A' }]);
    expect(() => mgr.updateStepStatus(plan.plan_id, plan.steps[0].step_id, 'running')).toThrow(/非法状态转移/);
  });

  it('completed（终态）→ 任何状态非法（除幂等）', () => {
    const { mgr, plan } = newPlan([{ desc: 'A' }]);
    mgr.updateStepStatus(plan.plan_id, plan.steps[0].step_id, 'ready');
    mgr.updateStepStatus(plan.plan_id, plan.steps[0].step_id, 'running');
    mgr.updateStepStatus(plan.plan_id, plan.steps[0].step_id, 'completed');

    // 终态 → 幂等允许
    mgr.updateStepStatus(plan.plan_id, plan.steps[0].step_id, 'completed');
    expect(() => mgr.updateStepStatus(plan.plan_id, plan.steps[0].step_id, 'ready')).toThrow();
  });

  it('failed → ready 合法（重试）', () => {
    const { mgr, plan } = newPlan([{ desc: 'A' }]);
    mgr.updateStepStatus(plan.plan_id, plan.steps[0].step_id, 'ready');
    mgr.updateStepStatus(plan.plan_id, plan.steps[0].step_id, 'running');
    mgr.updateStepStatus(plan.plan_id, plan.steps[0].step_id, 'failed');

    // 重试回来
    mgr.updateStepStatus(plan.plan_id, plan.steps[0].step_id, 'ready');
    expect(plan.steps[0].status).toBe('ready');
  });

  it('整体计划状态随步骤状态正确折叠', () => {
    const { mgr, plan } = newPlan([
      { desc: 'A' },
      { desc: 'B', deps: [0] },
      { desc: 'C', deps: [0] },
    ]);

    // 初始全 pending → pending
    expect(plan.status).toBe('pending');

    // A → running → plan=running
    mgr.updateStepStatus(plan.plan_id, plan.steps[0].step_id, 'ready');
    mgr.updateStepStatus(plan.plan_id, plan.steps[0].step_id, 'running');
    expect(plan.status).toBe('running');

    // A completed，B ready，C ready → plan=pending（还有 pending/ready）
    mgr.updateStepStatus(plan.plan_id, plan.steps[0].step_id, 'completed');
    expect(plan.status).toBe('pending');

    // 全部 completed → completed
    for (const step of plan.steps.slice(1)) {
      mgr.updateStepStatus(plan.plan_id, step.step_id, 'ready');
      mgr.updateStepStatus(plan.plan_id, step.step_id, 'running');
      mgr.updateStepStatus(plan.plan_id, step.step_id, 'completed');
    }
    expect(plan.status).toBe('completed');
  });

  it('不存在的 step_id → PLANNING_PLAN_INVALID', () => {
    const { mgr, plan } = newPlan([{ desc: 'A' }]);
    assertThrowsCode(() => mgr.updateStepStatus(plan.plan_id, 'nonexistent', 'running'), 'PLANNING_PLAN_INVALID');
  });

  it('不存在的 plan_id → PLANNING_PLAN_INVALID', () => {
    const mgr = new PlanManager();
    assertThrowsCode(() => mgr.updateStepStatus('ghost_plan', 'ghost_step', 'ready'), 'PLANNING_PLAN_INVALID');
  });
});

/* ------------------------------------------------------------------ */
/* cancelPlan                                                           */
/* ------------------------------------------------------------------ */

describe('PlanManager.cancelPlan', () => {
  it('取消所有非终态步骤', () => {
    const mgr = new PlanManager();
    const { steps } = buildPlanWithDeps('t', [
      { desc: 'A' },
      { desc: 'B', deps: [0] },
      { desc: 'C' },
    ]);
    const plan = mgr.createPlan({ user_request: 'X', steps });

    mgr.updateStepStatus(plan.plan_id, plan.steps[0].step_id, 'ready');
    mgr.updateStepStatus(plan.plan_id, plan.steps[0].step_id, 'running');
    mgr.updateStepStatus(plan.plan_id, plan.steps[0].step_id, 'completed');

    // B=C 还是 pending → 取消
    const cancelled = mgr.cancelPlan(plan.plan_id);
    expect(cancelled.steps[0].status).toBe('completed'); // 已完成保留
    expect(cancelled.steps[1].status).toBe('cancelled');
    expect(cancelled.steps[2].status).toBe('cancelled');
    expect(cancelled.status).toBe('cancelled');
  });

  it('全部已完成的计划 → cancelPlan 不改变任何步骤（终态不允许转出）', () => {
    const mgr = new PlanManager();
    const { steps } = buildPlanWithDeps('t', [{ desc: 'A' }]);
    const plan = mgr.createPlan({ user_request: 'X', steps });

    mgr.updateStepStatus(plan.plan_id, plan.steps[0].step_id, 'ready');
    mgr.updateStepStatus(plan.plan_id, plan.steps[0].step_id, 'running');
    mgr.updateStepStatus(plan.plan_id, plan.steps[0].step_id, 'completed');

    const result = mgr.cancelPlan(plan.plan_id);
    expect(result.steps[0].status).toBe('completed'); // 保持
    expect(result.status).toBe('completed'); // 保持
  });
});

/* ------------------------------------------------------------------ */
/* checkpoint 委托                                                      */
/* ------------------------------------------------------------------ */

describe('PlanManager + CheckpointManager', () => {
  it('不传 checkpoint → 正常工作（零外部依赖路径）', () => {
    const mgr = new PlanManager();
    const { steps } = buildPlanWithDeps('t', [{ desc: 'A' }]);
    const plan = mgr.createPlan({ user_request: 'X', steps });
    expect(plan.plan_id).toBeTruthy();
    mgr.updateStepStatus(plan.plan_id, plan.steps[0].step_id, 'ready');
  });

  it('传 checkpoint → createPlan 和 updateStepStatus 都触发 snapshot', () => {
    const db = new DatabaseSync(':memory:');
    const ckpt = new CheckpointManager(db);
    const mgr = new PlanManager({ checkpoint: ckpt });

    const { steps } = buildPlanWithDeps('t', [{ desc: 'A' }, { desc: 'B', deps: [0] }]);
    const plan = mgr.createPlan({ user_request: 'X', steps });

    // createPlan 应该存了一个 checkpoint
    expect(ckpt.has(plan.plan_id)).toBe(true);
    const before = ckpt.load(plan.plan_id);
    expect(before?.snapshot_at).toBeTruthy();

    // 状态变化 → 新 checkpoint
    mgr.updateStepStatus(plan.plan_id, plan.steps[0].step_id, 'ready');
    const after = ckpt.load(plan.plan_id);
    expect(after?.completed_step_ids).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* reshapePlan 重规划                                                   */
/* ------------------------------------------------------------------ */

describe('PlanManager.reshapePlan', () => {
  it('重规划：新步骤合法则替换已完成的保留 result', () => {
    const mgr = new PlanManager();
    const { steps } = buildPlanWithDeps('t', [
      { desc: '读日志' },
      { desc: '分析根因', deps: [0] },
    ]);
    const plan = mgr.createPlan({ user_request: 'X', steps });

    // 第一个步骤完成（带 result）
    mgr.updateStepStatus(plan.plan_id, plan.steps[0].step_id, 'ready');
    mgr.updateStepStatus(plan.plan_id, plan.steps[0].step_id, 'running');
    mgr.updateStepStatus(plan.plan_id, plan.steps[0].step_id, 'completed');
    mgr.updateStepResult(plan.plan_id, plan.steps[0].step_id, {
      success: true,
      toolCallCount: 2,
      durationMs: 1200,
      verificationPassed: true,
      summary: '发现 NPE',
    });
    const completedStepId = plan.steps[0].step_id;

    // 新计划：3 步骤，其中 step_id 和旧的第一个一样 → 保留 completed
    const newSteps: TaskStep[] = [
      createStep({ task_id: 't', description: '读日志（加强）' }),
      createStep({ task_id: 't', description: '调用链分析' }),
      createStep({ task_id: 't', description: '修复方案', dependencies: [] }),
    ];
    // 让第一个 step_id 保持和旧的一致
    newSteps[0].step_id = completedStepId;
    newSteps[2].dependencies = [newSteps[1].step_id];

    const reshaped = mgr.reshapePlan(plan.plan_id, newSteps, '发现原始计划不完整');
    expect(reshaped.steps).toHaveLength(3);
    // 第一个步骤因为 step_id 一致且旧的是 completed → 保留 completed
    expect(reshaped.steps[0].status).toBe('completed');
    expect(reshaped.steps[0].result?.summary).toBe('发现 NPE');
    // metadata 里有重规划标记
    expect(reshaped.metadata.replanned_reason).toBe('发现原始计划不完整');
    expect(reshaped.metadata.replanned_at).toBeTruthy();
  });

  it('重规划后存在环 → 抛错，原 plan 保持不变', () => {
    const mgr = new PlanManager();
    const { steps } = buildPlanWithDeps('t', [{ desc: 'A' }]);
    const plan = mgr.createPlan({ user_request: 'X', steps });

    const newSteps: TaskStep[] = [
      createStep({ task_id: 't', description: 'X' }),
      createStep({ task_id: 't', description: 'Y' }),
    ];
    newSteps[0].dependencies = [newSteps[1].step_id];
    newSteps[1].dependencies = [newSteps[0].step_id]; // 环

    assertThrowsCode(() => mgr.reshapePlan(plan.plan_id, newSteps, 'test'), 'PLANNING_DEPENDENCY_ERROR');
    // 原 plan 不变
    expect(mgr.getPlan(plan.plan_id).steps).toHaveLength(1);
  });
});
