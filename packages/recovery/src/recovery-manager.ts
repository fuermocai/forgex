/**
 * RecoveryManager：恢复管理器（v0.4.0 Phase 6）。
 *
 * 协调检查点、验证、计划、回滚，提供统一的恢复入口。
 *
 * 安全约束：
 *   - 恢复前必须通过 RecoveryVerifier 验证；
 *   - 不兼容时拒绝自动恢复；
 *   - 副作用操作需要人工确认。
 */
import { ForgeError } from '@forgex/shared';
import type { RecoveryCheckpoint, RecoveryPlan, RecoveryVerification, RollbackAction } from './types.js';
import { CheckpointStore } from './checkpoints/checkpoint-store.js';
import { RecoveryPlanner } from './coordinator/recovery-planner.js';
import { RecoveryVerifier } from './verification/recovery-verifier.js';
import { RollbackCoordinator } from './coordinator/rollback-coordinator.js';

export interface RecoverResult {
  checkpoint: RecoveryCheckpoint;
  verification: RecoveryVerification;
  plan: RecoveryPlan;
  /** 是否可自动恢复 */
  autoRecoverable: boolean;
  /** 需要人工确认的操作 */
  manualActions: string[];
}

export class RecoveryManager {
  private readonly checkpoints: CheckpointStore;
  private readonly planner: RecoveryPlanner;
  private readonly verifier: RecoveryVerifier;
  private readonly rollback: RollbackCoordinator;

  constructor(options: {
    checkpoints: CheckpointStore;
    planner: RecoveryPlanner;
    verifier: RecoveryVerifier;
    rollback: RollbackCoordinator;
  }) {
    this.checkpoints = options.checkpoints;
    this.planner = options.planner;
    this.verifier = options.verifier;
    this.rollback = options.rollback;
  }

  /**
   * 尝试从检查点恢复。
   * @returns 恢复结果（包含验证和计划）
   * @throws 如果检查点不存在
   */
  async recover(
    checkpointId: string,
    stepOperationMap: Record<string, string>,
  ): Promise<RecoverResult> {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint) {
      throw new ForgeError('RECOVERY_CHECKPOINT_NOT_FOUND', `检查点不存在: ${checkpointId}`);
    }

    // 1. 恢复前验证
    const verification = this.verifier.verify(checkpoint);

    // 2. 生成恢复计划
    const plan = this.planner.plan(
      checkpoint,
      checkpoint.currentStepId,
      stepOperationMap,
    );

    // 3. 判定是否可自动恢复
    const autoRecoverable =
      verification.safe && plan.requiresManualConfirmation.length === 0;

    return {
      checkpoint,
      verification,
      plan,
      autoRecoverable,
      manualActions: plan.requiresManualConfirmation,
    };
  }

  /**
   * 生成回滚计划。
   */
  planRollback(
    executedOperations: Array<{ stepId: string; operation: string; result: string }>,
    targetEnvironment: string,
  ): RollbackAction[] {
    return this.rollback.planRollback(executedOperations, targetEnvironment);
  }

  /**
   * 获取 workflow run 的最新检查点。
   */
  getLatestCheckpoint(workflowRunId: string): RecoveryCheckpoint | null {
    return this.checkpoints.getLatestByRun(workflowRunId);
  }

  /**
   * 列出所有检查点。
   */
  listCheckpoints(): RecoveryCheckpoint[] {
    return this.checkpoints.list();
  }
}
