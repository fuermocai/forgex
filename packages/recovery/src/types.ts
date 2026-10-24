/**
 * Recovery Engine 类型定义（v0.4.0 Phase 6）。
 */

/** 检查点记录 */
export interface RecoveryCheckpoint {
  id: string;
  /** 关联的 workflow run id */
  workflowRunId: string;
  /** workflow 定义 id */
  workflowId: string;
  /** 当前步骤 ID */
  currentStepId: string;
  /** 已完成的步骤 ID 列表 */
  completedSteps: string[];
  /** 环境快照（用于兼容性校验） */
  environmentSnapshot: EnvironmentSnapshot;
  /** 权限策略版本（恢复时重新校验） */
  policyVersion: string;
  /** 已执行操作的幂等键列表 */
  idempotencyKeys: string[];
  /** 创建时间 */
  createdAt: string;
  /** 最后更新时间 */
  updatedAt: string;
}

/** 环境快照 */
export interface EnvironmentSnapshot {
  /** 操作系统 */
  os: string;
  /** Node 版本 */
  nodeVersion: string;
  /** 工作区路径 */
  workspacePath: string;
  /** Git commit hash（如果在 git 仓库中） */
  gitCommit?: string;
  /** 环境变量键列表（不存值） */
  envKeys: string[];
  /** 自定义快照字段 */
  custom?: Record<string, string>;
}

/** 幂等操作记录 */
export interface IdempotentOperation {
  /** 幂等键 */
  key: string;
  /** 操作描述 */
  operation: string;
  /** 操作结果 */
  result: 'success' | 'failed';
  /** 执行时间 */
  executedAt: string;
}

/** 恢复计划 */
export interface RecoveryPlan {
  /** 检查点 ID */
  checkpointId: string;
  /** 可安全跳过的步骤（已完成且幂等） */
  skippableSteps: string[];
  /** 需要重新执行的步骤 */
  retrySteps: string[];
  /** 需要人工确认的步骤（不可幂等） */
  requiresManualConfirmation: string[];
  /** 恢复策略 */
  strategy: 'resume' | 'restart' | 'abort';
}

/** 恢复验证结果 */
export interface RecoveryVerification {
  /** 是否可安全恢复 */
  safe: boolean;
  /** 环境兼容性 */
  environmentCompatible: boolean;
  /** 权限策略是否一致 */
  policyCompatible: boolean;
  /** 已完成步骤是否可幂等跳过 */
  idempotencyValid: boolean;
  /** 不兼容原因 */
  reasons: string[];
}

/** 回滚操作 */
export interface RollbackAction {
  id: string;
  /** 操作描述 */
  description: string;
  /** 目标环境 */
  targetEnvironment: string;
  /** 风险等级 */
  riskLevel: 'L1' | 'L2' | 'L3';
  /** 是否可自动执行 */
  autoExecutable: boolean;
  /** 回滚脚本/命令 */
  command?: string;
}
