/**
 * 场景 E：任务恢复 — 端到端测试（v0.4.0 Phase 7）。
 *
 * 验证：
 *   - 模拟进程崩溃后从检查点恢复；
 *   - 已完成步骤被识别；
 *   - 避免重复副作用操作；
 *   - 环境不兼容时拒绝恢复。
 */
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  WorkflowRegistry,
  WorkflowRunner,
  WorkflowCheckpoint,
  registerBuiltinWorkflows,
  computeWorkflowState,
  type NodeExecutor,
  type WorkflowNodeResult,
} from '@forgex/workflows';
import { AuditLogger, MemoryAuditSink } from '@forgex/security';
import {
  CheckpointStore,
  RecoveryPlanner,
  RollbackCoordinator,
  RecoveryVerifier,
  RecoveryManager,
  type EnvironmentSnapshot,
} from '@forgex/recovery';

function makeEnv(): EnvironmentSnapshot {
  return {
    os: process.platform,
    nodeVersion: process.version,
    workspacePath: process.cwd(),
    envKeys: Object.keys(process.env).slice(0, 10),
  };
}

const successResult: WorkflowNodeResult = {
  success: true,
  toolCallCount: 0,
  durationMs: 0,
};

describe('场景 E：任务恢复端到端', () => {
  it('从检查点恢复，跳过已完成的幂等步骤', async () => {
    const registry = new WorkflowRegistry();
    registerBuiltinWorkflows(registry);

    const db = new DatabaseSync(':memory:');
    const checkpoint = new WorkflowCheckpoint(db);
    const auditSink = new MemoryAuditSink();
    const auditLogger = new AuditLogger({ sinks: [auditSink] });

    // 第一次运行：plan 步骤失败（模拟崩溃后未完成）
    const executor: NodeExecutor = {
      async executeTask(node): Promise<WorkflowNodeResult> {
        if (node.name === 'Plan') {
          return { success: false, toolCallCount: 0, durationMs: 0, failureReason: '进程崩溃' };
        }
        return { ...successResult };
      },
      async executeApproval(): Promise<boolean> {
        return true;
      },
      async executeVerification(): Promise<boolean> {
        return true;
      },
      async executeCondition(): Promise<string | null> {
        return null;
      },
    };

    const runner = new WorkflowRunner({
      registry,
      checkpoint,
      auditLogger,
      nodeExecutor: executor,
    });

    const def = registry.get('bug-fix')!;
    // 第一次运行：plan 失败，工作流进入 failed
    const firstRun = await runner.run(def);
    const firstState = computeWorkflowState(firstRun.nodes);
    expect(firstState).toBe('failed');

    // 创建恢复检查点（模拟真实进程崩溃后的检查点）
    const recoveryDb = new DatabaseSync(':memory:');
    const recoveryStore = new CheckpointStore(recoveryDb);
    const cp = recoveryStore.create({
      workflowRunId: 'run-crash',
      workflowId: 'bug-fix',
      currentStepId: 'plan',
      completedSteps: ['requirement', 'analyze'],
      environmentSnapshot: makeEnv(),
      policyVersion: 'v1',
      idempotencyKeys: ['req-key', 'analyze-key'],
    });

    // 恢复验证
    const verifier = new RecoveryVerifier({
      environmentProvider: makeEnv,
      currentPolicyVersion: 'v1',
    });
    const verification = verifier.verify(cp);
    expect(verification.safe).toBe(true);

    // 生成恢复计划
    const planner = new RecoveryPlanner();
    const plan = planner.plan(cp, 'plan', {
      requirement: 'read_file',
      analyze: 'read_file',
      plan: 'read_file',
      implement: 'file_write',
      test: 'run_tests',
      review: 'read_file',
      build: 'run_tests',
      deliver: 'git_commit',
    });

    // 已完成的幂等步骤可跳过
    expect(plan.skippableSteps).toContain('requirement');
    expect(plan.skippableSteps).toContain('analyze');
    // 当前步骤需要重试
    expect(plan.retrySteps).toContain('plan');
  });

  it('环境不兼容时拒绝恢复', () => {
    const recoveryDb = new DatabaseSync(':memory:');
    const recoveryStore = new CheckpointStore(recoveryDb);
    const cp = recoveryStore.create({
      workflowRunId: 'run-1',
      workflowId: 'bug-fix',
      currentStepId: 'plan',
      completedSteps: ['requirement'],
      environmentSnapshot: { ...makeEnv(), os: 'linux' },
      policyVersion: 'v1',
      idempotencyKeys: ['k1'],
    });

    const verifier = new RecoveryVerifier({
      environmentProvider: makeEnv,
      currentPolicyVersion: 'v1',
    });
    const verification = verifier.verify(cp);
    expect(verification.safe).toBe(false);
    expect(verification.environmentCompatible).toBe(false);
  });

  it('权限策略版本不匹配时拒绝恢复', () => {
    const recoveryDb = new DatabaseSync(':memory:');
    const recoveryStore = new CheckpointStore(recoveryDb);
    const cp = recoveryStore.create({
      workflowRunId: 'run-1',
      workflowId: 'bug-fix',
      currentStepId: 'plan',
      completedSteps: ['requirement'],
      environmentSnapshot: makeEnv(),
      policyVersion: 'v1',
      idempotencyKeys: ['k1'],
    });

    const verifier = new RecoveryVerifier({
      environmentProvider: makeEnv,
      currentPolicyVersion: 'v2',
    });
    const verification = verifier.verify(cp);
    expect(verification.safe).toBe(false);
    expect(verification.policyCompatible).toBe(false);
  });

  it('RecoveryManager 集成：副作用操作需人工确认', async () => {
    const recoveryDb = new DatabaseSync(':memory:');
    const recoveryStore = new CheckpointStore(recoveryDb);
    const manager = new RecoveryManager({
      checkpoints: recoveryStore,
      planner: new RecoveryPlanner(),
      verifier: new RecoveryVerifier({
        environmentProvider: makeEnv,
        currentPolicyVersion: 'v1',
      }),
      rollback: new RollbackCoordinator(),
    });

    const cp = recoveryStore.create({
      workflowRunId: 'run-1',
      workflowId: 'deployment-prep',
      currentStepId: 'deploy',
      completedSteps: ['prepare'],
      environmentSnapshot: makeEnv(),
      policyVersion: 'v1',
      idempotencyKeys: ['k1'],
    });

    const result = await manager.recover(cp.id, {
      prepare: 'read_file',
      deploy: 'deploy',
    });

    expect(result.autoRecoverable).toBe(false);
    expect(result.manualActions).toContain('deploy');
  });
});
