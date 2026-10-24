/**
 * RollbackCoordinator：回滚协调器（v0.4.0 Phase 6）。
 *
 * 职责：
 *   - 生成回滚计划；
 *   - 生产回滚走 L3 审批流程；
 *   - 不能假设所有操作都可回滚。
 *
 * 安全约束：
 *   - Git 回滚不能替代数据库或基础设施回滚；
 *   - 生产回滚必须遵循独立审批流程；
 *   - 默认不允许自动执行生产变更。
 */
import type { RollbackAction } from '../types.js';

export class RollbackCoordinator {
  /**
   * 生成回滚操作列表。
   * @param executedOperations 已执行的操作列表（按执行顺序）
   * @param targetEnvironment 目标环境
   */
  planRollback(
    executedOperations: Array<{ stepId: string; operation: string; result: string }>,
    targetEnvironment: string,
  ): RollbackAction[] {
    const actions: RollbackAction[] = [];
    const isProduction = targetEnvironment === 'production' || targetEnvironment === 'prod';

    // 逆序生成回滚操作
    for (let i = executedOperations.length - 1; i >= 0; i--) {
      const op = executedOperations[i]!;
      const rollback = this.createRollbackAction(op, isProduction);
      if (rollback) {
        actions.push(rollback);
      }
    }

    return actions;
  }

  /**
   * 判断回滚操作是否可自动执行。
   * 生产环境的 L3 操作必须人工审批。
   */
  canAutoExecute(action: RollbackAction): boolean {
    if (action.riskLevel === 'L3') return false;
    return action.autoExecutable;
  }

  private createRollbackAction(
    op: { stepId: string; operation: string; result: string },
    isProduction: boolean,
  ): RollbackAction | null {
    // 根据操作类型生成对应的回滚动作
    const rollbackMap: Record<string, { description: string; riskLevel: RollbackAction['riskLevel']; auto: boolean }> = {
      git_commit: {
        description: `Git 回滚: 撤销 ${op.stepId} 的提交`,
        riskLevel: isProduction ? 'L2' : 'L1',
        auto: !isProduction,
      },
      file_write: {
        description: `恢复文件: ${op.stepId}`,
        riskLevel: isProduction ? 'L2' : 'L1',
        auto: !isProduction,
      },
      deploy: {
        description: `回滚部署: ${op.stepId}`,
        riskLevel: 'L3',
        auto: false,
      },
      db_migrate: {
        description: `数据库回滚迁移: ${op.stepId}`,
        riskLevel: 'L3',
        auto: false,
      },
    };

    const config = rollbackMap[op.operation];
    if (!config) {
      // 未知操作，不生成自动回滚，标记为需要人工处理
      return {
        id: `rollback-${op.stepId}`,
        description: `手动回滚: ${op.operation} (${op.stepId}) — 无自动回滚方案`,
        targetEnvironment: isProduction ? 'production' : 'non-production',
        riskLevel: isProduction ? 'L3' : 'L2',
        autoExecutable: false,
      };
    }

    return {
      id: `rollback-${op.stepId}`,
      description: config.description,
      targetEnvironment: isProduction ? 'production' : 'non-production',
      riskLevel: config.riskLevel,
      autoExecutable: config.auto,
    };
  }
}
