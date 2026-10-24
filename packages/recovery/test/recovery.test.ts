/**
 * Recovery Engine 测试（v0.4.0 Phase 6）。
 *
 * 重点验证：
 *   1. 检查点持久化；
 *   2. 恢复前验证（环境兼容、权限策略）；
 *   3. 幂等计划生成；
 *   4. 回滚协调（生产 L3 不可自动执行）；
 *   5. RecoveryManager 集成。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { CheckpointStore } from '../src/checkpoints/checkpoint-store.js';
import { RecoveryPlanner } from '../src/coordinator/recovery-planner.js';
import { RollbackCoordinator } from '../src/coordinator/rollback-coordinator.js';
import { RecoveryVerifier } from '../src/verification/recovery-verifier.js';
import { RecoveryManager } from '../src/recovery-manager.js';
import type { EnvironmentSnapshot } from '../src/types.js';

function makeEnv(overrides: Partial<EnvironmentSnapshot> = {}): EnvironmentSnapshot {
  return {
    os: 'win32',
    nodeVersion: 'v22.18.0',
    workspacePath: 'e:/ForgeX',
    envKeys: ['PATH', 'HOME'],
    ...overrides,
  };
}

describe('CheckpointStore', () => {
  let db: DatabaseSync;
  let store: CheckpointStore;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    store = new CheckpointStore(db);
  });

  it('创建并查询检查点', () => {
    const cp = store.create({
      workflowRunId: 'run-1',
      workflowId: 'bug-fix',
      currentStepId: 'step-2',
      completedSteps: ['step-1'],
      environmentSnapshot: makeEnv(),
      policyVersion: 'v1',
      idempotencyKeys: ['key-1'],
    });

    const loaded = store.get(cp.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.workflowRunId).toBe('run-1');
    expect(loaded?.completedSteps).toEqual(['step-1']);
    expect(loaded?.policyVersion).toBe('v1');
  });

  it('更新检查点', () => {
    const cp = store.create({
      workflowRunId: 'run-1',
      workflowId: 'wf',
      currentStepId: 'step-1',
      completedSteps: [],
      environmentSnapshot: makeEnv(),
      policyVersion: 'v1',
      idempotencyKeys: [],
    });

    store.update(cp.id, {
      currentStepId: 'step-2',
      completedSteps: ['step-1'],
      idempotencyKeys: ['key-1'],
    });

    const loaded = store.get(cp.id);
    expect(loaded?.currentStepId).toBe('step-2');
    expect(loaded?.completedSteps).toEqual(['step-1']);
  });

  it('getLatestByRun 返回最新检查点', () => {
    const cp1 = store.create({
      workflowRunId: 'run-1',
      workflowId: 'wf',
      currentStepId: 'step-1',
      completedSteps: [],
      environmentSnapshot: makeEnv(),
      policyVersion: 'v1',
      idempotencyKeys: [],
    });
    const cp2 = store.create({
      workflowRunId: 'run-1',
      workflowId: 'wf',
      currentStepId: 'step-2',
      completedSteps: ['step-1'],
      environmentSnapshot: makeEnv(),
      policyVersion: 'v1',
      idempotencyKeys: [],
    });

    const latest = store.getLatestByRun('run-1');
    expect(latest).not.toBeNull();
    expect([cp1.id, cp2.id]).toContain(latest!.id);
    expect(latest!.workflowRunId).toBe('run-1');
  });
});

describe('RecoveryPlanner', () => {
  it('幂等操作可跳过', () => {
    const planner = new RecoveryPlanner();
    const cp = {
      id: 'cp1',
      workflowRunId: 'r1',
      workflowId: 'wf',
      currentStepId: 'step-2',
      completedSteps: ['step-1'],
      environmentSnapshot: makeEnv(),
      policyVersion: 'v1',
      idempotencyKeys: ['k1'],
      createdAt: '',
      updatedAt: '',
    };

    const plan = planner.plan(cp, 'step-2', { 'step-1': 'read_file', 'step-2': 'run_tests' });
    expect(plan.skippableSteps).toContain('step-1');
    expect(plan.retrySteps).toContain('step-2');
  });

  it('副作用操作需要人工确认', () => {
    const planner = new RecoveryPlanner();
    const cp = {
      id: 'cp1',
      workflowRunId: 'r1',
      workflowId: 'wf',
      currentStepId: 'step-2',
      completedSteps: ['step-1'],
      environmentSnapshot: makeEnv(),
      policyVersion: 'v1',
      idempotencyKeys: ['k1'],
      createdAt: '',
      updatedAt: '',
    };

    const plan = planner.plan(cp, 'step-2', { 'step-1': 'deploy', 'step-2': 'db_migrate' });
    expect(plan.requiresManualConfirmation).toContain('step-1');
    expect(plan.requiresManualConfirmation).toContain('step-2');
  });
});

describe('RollbackCoordinator', () => {
  it('生产环境 deploy 回滚为 L3 且不可自动执行', () => {
    const rc = new RollbackCoordinator();
    const actions = rc.planRollback(
      [{ stepId: 's1', operation: 'deploy', result: 'success' }],
      'production',
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]?.riskLevel).toBe('L3');
    expect(rc.canAutoExecute(actions[0]!)).toBe(false);
  });

  it('非生产环境 git_commit 可自动回滚', () => {
    const rc = new RollbackCoordinator();
    const actions = rc.planRollback(
      [{ stepId: 's1', operation: 'git_commit', result: 'success' }],
      'staging',
    );
    expect(actions[0]?.riskLevel).toBe('L1');
    expect(rc.canAutoExecute(actions[0]!)).toBe(true);
  });

  it('未知操作标记为需要人工处理', () => {
    const rc = new RollbackCoordinator();
    const actions = rc.planRollback(
      [{ stepId: 's1', operation: 'unknown_op', result: 'success' }],
      'staging',
    );
    expect(actions[0]?.autoExecutable).toBe(false);
  });
});

describe('RecoveryVerifier', () => {
  it('环境和策略兼容时验证通过', () => {
    const verifier = new RecoveryVerifier({
      environmentProvider: () => makeEnv(),
      currentPolicyVersion: 'v1',
    });

    const cp = {
      id: 'cp1',
      workflowRunId: 'r1',
      workflowId: 'wf',
      currentStepId: 'step-1',
      completedSteps: [],
      environmentSnapshot: makeEnv(),
      policyVersion: 'v1',
      idempotencyKeys: [],
      createdAt: '',
      updatedAt: '',
    };

    const result = verifier.verify(cp);
    expect(result.safe).toBe(true);
    expect(result.environmentCompatible).toBe(true);
    expect(result.policyCompatible).toBe(true);
  });

  it('操作系统不兼容时验证失败', () => {
    const verifier = new RecoveryVerifier({
      environmentProvider: () => makeEnv({ os: 'linux' }),
      currentPolicyVersion: 'v1',
    });

    const cp = {
      id: 'cp1',
      workflowRunId: 'r1',
      workflowId: 'wf',
      currentStepId: 'step-1',
      completedSteps: [],
      environmentSnapshot: makeEnv({ os: 'win32' }),
      policyVersion: 'v1',
      idempotencyKeys: [],
      createdAt: '',
      updatedAt: '',
    };

    const result = verifier.verify(cp);
    expect(result.safe).toBe(false);
    expect(result.environmentCompatible).toBe(false);
    expect(result.reasons.some((r) => r.includes('操作系统'))).toBe(true);
  });

  it('权限策略版本不匹配时验证失败', () => {
    const verifier = new RecoveryVerifier({
      environmentProvider: () => makeEnv(),
      currentPolicyVersion: 'v2',
    });

    const cp = {
      id: 'cp1',
      workflowRunId: 'r1',
      workflowId: 'wf',
      currentStepId: 'step-1',
      completedSteps: [],
      environmentSnapshot: makeEnv(),
      policyVersion: 'v1',
      idempotencyKeys: [],
      createdAt: '',
      updatedAt: '',
    };

    const result = verifier.verify(cp);
    expect(result.safe).toBe(false);
    expect(result.policyCompatible).toBe(false);
    expect(result.reasons.some((r) => r.includes('权限策略'))).toBe(true);
  });
});

describe('RecoveryManager', () => {
  let db: DatabaseSync;
  let store: CheckpointStore;
  let manager: RecoveryManager;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    store = new CheckpointStore(db);
    manager = new RecoveryManager({
      checkpoints: store,
      planner: new RecoveryPlanner(),
      verifier: new RecoveryVerifier({
        environmentProvider: () => makeEnv(),
        currentPolicyVersion: 'v1',
      }),
      rollback: new RollbackCoordinator(),
    });
  });

  it('兼容环境下可自动恢复', async () => {
    const cp = store.create({
      workflowRunId: 'run-1',
      workflowId: 'bug-fix',
      currentStepId: 'step-2',
      completedSteps: ['step-1'],
      environmentSnapshot: makeEnv(),
      policyVersion: 'v1',
      idempotencyKeys: ['k1'],
    });

    const result = await manager.recover(cp.id, { 'step-1': 'read_file', 'step-2': 'run_tests' });
    expect(result.verification.safe).toBe(true);
    expect(result.autoRecoverable).toBe(true);
  });

  it('副作用操作需要人工确认', async () => {
    const cp = store.create({
      workflowRunId: 'run-1',
      workflowId: 'deploy',
      currentStepId: 'step-2',
      completedSteps: ['step-1'],
      environmentSnapshot: makeEnv(),
      policyVersion: 'v1',
      idempotencyKeys: ['k1'],
    });

    const result = await manager.recover(cp.id, { 'step-1': 'deploy', 'step-2': 'db_migrate' });
    expect(result.autoRecoverable).toBe(false);
    expect(result.manualActions).toContain('step-1');
    expect(result.manualActions).toContain('step-2');
  });

  it('检查点不存在抛错', async () => {
    await expect(manager.recover('nonexistent', {})).rejects.toThrow('检查点不存在');
  });
});
