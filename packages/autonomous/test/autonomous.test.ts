/**
 * Autonomous Task Runner 测试（v0.5.0 Phase 2）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { BudgetTracker, DEFAULT_BUDGET_LIMITS, LIGHT_BUDGET_LIMITS, HEAVY_BUDGET_LIMITS } from '../src/budget/execution-budget.js';
import { AutonomousRunner, type AutonomousStepExecutor, type PlannedStep } from '../src/runner/autonomous-runner.js';
import { ContinuationManager } from '../src/continuation/continuation-manager.js';
import {
  makeStructuredRequirement,
  makeCriterion,
} from '@forgex/requirement-engine';
import { RequirementAnalyzer } from '@forgex/requirement-engine';
import { CheckpointStore, RecoveryVerifier } from '@forgex/recovery';

describe('BudgetTracker', () => {
  it('默认预算 limits 合理', () => {
    const t = new BudgetTracker();
    const s = t.snapshot();
    expect(s.limits.maxTokens).toBe(DEFAULT_BUDGET_LIMITS.maxTokens);
    expect(s.limits.maxTimeMs).toBe(DEFAULT_BUDGET_LIMITS.maxTimeMs);
  });

  it('自定义预算覆盖默认值', () => {
    const t = new BudgetTracker({ maxTokens: 100, maxSteps: 5 });
    const s = t.snapshot();
    expect(s.limits.maxTokens).toBe(100);
    expect(s.limits.maxSteps).toBe(5);
  });

  it('Token 耗尽抛预算异常', () => {
    const t = new BudgetTracker({ maxTokens: 5 });
    expect(() => {
      t.addTokens(3);
      t.addTokens(3);
    }).toThrow('Token');
  });

  it('Tool call 耗尽抛预算异常', () => {
    const t = new BudgetTracker({ maxToolCalls: 2 });
    expect(() => {
      t.addToolCall();
      t.addToolCall();
      t.addToolCall();
    }).toThrow('工具调用');
  });

  it('Model call 耗尽抛预算异常', () => {
    const t = new BudgetTracker({ maxModelCalls: 1 });
    expect(() => {
      t.addModelCall();
      t.addModelCall();
    }).toThrow('模型调用');
  });

  it('Step 耗尽抛预算异常', () => {
    const t = new BudgetTracker({ maxSteps: 1 });
    expect(() => {
      t.addStep();
      t.addStep();
    }).toThrow('步骤');
  });

  it('时间预算耗尽（刷新后 check 触发）', () => {
    const t = new BudgetTracker({ maxTimeMs: 1 });
    // busy wait 确保时间流逝
    const start = Date.now();
    while (Date.now() - start < 2) { /* noop */ }
    t.refreshTime();
    expect(() => t.check()).toThrow('时间');
  });

  it('utilization 返回 0-1', () => {
    const t = new BudgetTracker({ maxTokens: 100 });
    t.addTokens(30);
    const u = t.utilization();
    expect(u).toBeGreaterThanOrEqual(0.29);
    expect(u).toBeLessThanOrEqual(0.31);
  });

  it('BUDGET_EXCEEDED code 在 ForgeError 上', () => {
    let err: any = null;
    try {
      const t = new BudgetTracker({ maxTokens: 3 });
      t.addTokens(4);
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect(err.code).toBe('BUDGET_EXCEEDED');
  });

  it('LIGHT_BUDGET_LIMITS 和 HEAVY_BUDGET_LIMITS 常量存在且合理', () => {
    expect(LIGHT_BUDGET_LIMITS.maxTokens).toBeLessThan(DEFAULT_BUDGET_LIMITS.maxTokens);
    expect(HEAVY_BUDGET_LIMITS.maxTokens).toBeGreaterThan(DEFAULT_BUDGET_LIMITS.maxTokens);
  });
});

function makeApprovedRequirement() {
  return makeStructuredRequirement({
    original: '增加 RBAC 权限管理系统',
    parsed: { category: 'feature', summary: 'RBAC 权限管理', functionalReqs: ['角色', '权限'], nonFunctionalReqs: ['安全'] },
    acceptanceCriteria: [
      makeCriterion({ description: '角色创建正常', testable: true, verificationMethod: '运行单测', approved: true }),
      makeCriterion({ description: '权限分配正常', testable: true, verificationMethod: '运行单测', approved: true }),
    ],
    traceId: 'trace_test_001',
  });
}

describe('AutonomousRunner 基本流程', () => {
  let analyzer: RequirementAnalyzer;

  beforeEach(() => {
    analyzer = new RequirementAnalyzer();
  });

  it('执行已批准需求 → success=true', async () => {
    const budget = new BudgetTracker({ maxSteps: 10, maxToolCalls: 20, maxTokens: 5000, maxModelCalls: 10, maxTimeMs: 60000 });
    const runner = new AutonomousRunner({ budget, analyzer });
    const req = makeApprovedRequirement();
    const executor = new MockExecutor({ steps: 3 });
    const result = await runner.execute(
      req,
      { traceId: req.traceId, requirementId: req.id, status: 'pending', createdAt: new Date().toISOString() } as any,
      executor,
    );

    expect(result.success).toBe(true);
    expect(result.totalStepsExecuted).toBe(3);
    expect(result.steps.every((s) => s.status === 'completed')).toBe(true);
  });

  it('预算耗尽自动停止 → success=false 且有 cancelled step', async () => {
    const budget = new BudgetTracker({ maxSteps: 2, maxToolCalls: 2, maxTokens: 1000, maxModelCalls: 5, maxTimeMs: 60000 });
    const runner = new AutonomousRunner({ budget, analyzer });
    const req = makeApprovedRequirement();
    const executor = new MockExecutor({ steps: 10 });
    const result = await runner.execute(
      req,
      { traceId: req.traceId, requirementId: req.id, status: 'pending', createdAt: new Date().toISOString() } as any,
      executor,
    );

    expect(result.success).toBe(false);
    expect(result.steps.some((s) => s.status === 'cancelled')).toBe(true);
  });

  it('未批准需求触发 assertReady 门禁', async () => {
    const budget = new BudgetTracker();
    const runner = new AutonomousRunner({ budget, analyzer });
    const req = makeStructuredRequirement({
      original: 'x',
      parsed: { category: 'feature', summary: '', functionalReqs: [], nonFunctionalReqs: [] },
      acceptanceCriteria: [
        makeCriterion({ description: 'A', testable: true, verificationMethod: 'x', approved: false }),
      ],
    });
    const executor = new MockExecutor({ steps: 5 });
    await expect(
      runner.execute(
        req,
        { traceId: req.traceId, requirementId: req.id, status: 'pending', createdAt: new Date().toISOString() } as any,
        executor,
      ),
    ).rejects.toThrow();
  });

  it('步骤失败自动重试 → 最终成功', async () => {
    const budget = new BudgetTracker({ maxSteps: 10, maxToolCalls: 20, maxTokens: 5000, maxModelCalls: 10, maxTimeMs: 60000 });
    const runner = new AutonomousRunner({ budget, analyzer, maxRetryPerStep: 3 });
    const req = makeApprovedRequirement();
    const calls: Record<string, number> = {};
    const executor = new MockExecutor({
      steps: 3,
      beforeStep: (step) => {
        calls[step.id] = (calls[step.id] ?? 0) + 1;
        if (calls[step.id]! < 3) throw new Error('模拟暂时性失败');
      },
    });
    const result = await runner.execute(
      req,
      { traceId: req.traceId, requirementId: req.id, status: 'pending', createdAt: new Date().toISOString() } as any,
      executor,
    );
    expect(result.success).toBe(true);
  });
});

describe('ContinuationManager', () => {
  let db: DatabaseSync;
  let store: CheckpointStore;
  let verifier: RecoveryVerifier;
  let cm: ContinuationManager;

  function makeEnv() {
    return {
      os: process.platform,
      nodeVersion: process.version,
      workspacePath: process.cwd(),
      envKeys: Object.keys(process.env),
    };
  }

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    store = new CheckpointStore(db);
    verifier = new RecoveryVerifier({ environmentProvider: makeEnv, currentPolicyVersion: 'v1' });
    cm = new ContinuationManager({ checkpointStore: store, recoveryVerifier: verifier, checkpointInterval: 2 });
  });

  it('startRun 返回 runId', () => {
    const runId = cm.startRun('req_123');
    expect(runId.startsWith('run_')).toBe(true);
  });

  it('saveCheckpoint 写入检查点', () => {
    const runId = cm.startRun('req_123');
    cm.saveCheckpoint({
      runId,
      requirementId: 'req_123',
      currentStepId: 'step_5',
      completedStepIds: ['step_1', 'step_2', 'step_3', 'step_4'],
      idempotencyKeys: ['key_1', 'key_2'],
    });
    expect(store.getLatestByRun(runId)).not.toBeNull();
  });

  it('verifyRecoverable 有检查点 → true', () => {
    const runId = cm.startRun('req_123');
    cm.saveCheckpoint({
      runId,
      requirementId: 'req_123',
      currentStepId: 'step_1',
      completedStepIds: [],
      idempotencyKeys: [],
    });
    expect(cm.verifyRecoverable(runId)).toBe(true);
  });

  it('verifyRecoverable 无检查点 → 抛 REQUIREMENT_TRACE_NOT_FOUND', () => {
    let err: any = null;
    try {
      cm.verifyRecoverable('nonexistent_run');
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect(err.code).toBe('REQUIREMENT_TRACE_NOT_FOUND');
  });
});

/* ====================== MockExecutor ====================== */

class MockExecutor implements AutonomousStepExecutor {
  private readonly stepCount: number;
  private readonly beforeStep?: (step: PlannedStep) => void;

  constructor(opts: { steps: number; beforeStep?: (s: PlannedStep) => void }) {
    this.stepCount = opts.steps;
    this.beforeStep = opts.beforeStep;
  }

  planSteps(_req: any): PlannedStep[] {
    return Array.from({ length: this.stepCount }, (_, i) => ({
      id: `step_${i}`,
      name: `步骤 ${i}`,
      riskLevel: i === 0 ? 'L1' : 'L0',
      description: `第 ${i} 步执行`,
    }));
  }

  async executeStep(step: PlannedStep) {
    if (this.beforeStep) this.beforeStep(step);
    return {
      success: true,
      tokenUsage: 50,
      llmCalls: 1,
      summary: `${step.name} 执行成功`,
    };
  }
}
