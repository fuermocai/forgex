/**
 * RecoveryPlanner：恢复计划生成器（v0.4.0 Phase 6）。
 *
 * 职责：
 *   - 判断已完成步骤是否可幂等跳过；
 *   - 生成恢复策略（resume/restart/abort）；
 *   - 识别需要人工确认的步骤。
 *
 * 安全约束：
 *   - 不能盲目重复副作用操作；
 *   - 每个可重试操作必须定义幂等语义。
 */
import type { RecoveryCheckpoint, RecoveryPlan } from '../types.js';

/** 幂等操作集合（可安全跳过） */
const IDEMPOTENT_OPERATIONS = new Set([
  'read_file',
  'list_directory',
  'git_status',
  'git_diff',
  'git_log',
  'run_tests',
  'lint',
  'typecheck',
  'verify',
]);

/** 不可幂等、需要人工确认的操作 */
const SIDE_EFFECT_OPERATIONS = new Set([
  'deploy',
  'db_migrate',
  'db_write',
  'delete_resource',
  'restart_service',
  'modify_firewall',
]);

export class RecoveryPlanner {
  /**
   * 生成恢复计划。
   *
   * @param checkpoint 检查点
   * @param currentStepId 当前要执行的步骤
   * @param stepOperationMap 步骤 ID → 操作类型映射
   */
  plan(
    checkpoint: RecoveryCheckpoint,
    currentStepId: string,
    stepOperationMap: Record<string, string>,
  ): RecoveryPlan {
    const skippableSteps: string[] = [];
    const retrySteps: string[] = [];
    const requiresManualConfirmation: string[] = [];

    // 已完成步骤中，幂等操作可跳过
    for (const stepId of checkpoint.completedSteps) {
      const operation = stepOperationMap[stepId];
      if (operation && IDEMPOTENT_OPERATIONS.has(operation)) {
        skippableSteps.push(stepId);
      } else if (operation && SIDE_EFFECT_OPERATIONS.has(operation)) {
        // 已完成的副作用操作需要人工确认是否重复
        requiresManualConfirmation.push(stepId);
      }
    }

    // 当前步骤
    const currentOperation = stepOperationMap[currentStepId];
    if (currentOperation && SIDE_EFFECT_OPERATIONS.has(currentOperation)) {
      requiresManualConfirmation.push(currentStepId);
    } else {
      retrySteps.push(currentStepId);
    }

    // 决定恢复策略
    let strategy: RecoveryPlan['strategy'] = 'resume';
    if (requiresManualConfirmation.length > 0) {
      // 有副作用操作需要确认，策略为 resume 但带人工确认
      strategy = 'resume';
    }
    if (checkpoint.completedSteps.length === 0) {
      strategy = 'restart';
    }

    return {
      checkpointId: checkpoint.id,
      skippableSteps,
      retrySteps,
      requiresManualConfirmation,
      strategy,
    };
  }

  /** 判断操作是否幂等 */
  isIdempotent(operation: string): boolean {
    return IDEMPOTENT_OPERATIONS.has(operation);
  }

  /** 判断操作是否有副作用 */
  hasSideEffects(operation: string): boolean {
    return SIDE_EFFECT_OPERATIONS.has(operation);
  }
}
