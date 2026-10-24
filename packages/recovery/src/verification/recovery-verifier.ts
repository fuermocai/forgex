/**
 * RecoveryVerifier：恢复前验证器（v0.4.0 Phase 6）。
 *
 * 职责：
 *   - 恢复前重新验证权限；
 *   - 确认环境没有发生不兼容变化；
 *   - 验证幂等性。
 *
 * 安全约束：
 *   - 恢复前重新验证权限（不能假设原审批仍然有效）；
 *   - 环境不兼容时不能盲目恢复；
 *   - 不兼容原因必须明确列出。
 */
import type { EnvironmentSnapshot, RecoveryCheckpoint, RecoveryVerification } from '../types.js';

export interface RecoveryVerifierOptions {
  /** 当前环境快照生成器 */
  environmentProvider: () => EnvironmentSnapshot;
  /** 当前权限策略版本 */
  currentPolicyVersion: string;
}

export class RecoveryVerifier {
  private readonly options: RecoveryVerifierOptions;

  constructor(options: RecoveryVerifierOptions) {
    this.options = options;
  }

  /**
   * 验证是否可安全恢复。
   */
  verify(checkpoint: RecoveryCheckpoint): RecoveryVerification {
    const reasons: string[] = [];
    const currentEnv = this.options.environmentProvider();

    // 1. 环境兼容性校验
    const envCompatible = this.verifyEnvironment(checkpoint.environmentSnapshot, currentEnv);
    if (!envCompatible.compatible) {
      reasons.push(...envCompatible.reasons);
    }

    // 2. 权限策略版本校验
    const policyCompatible = checkpoint.policyVersion === this.options.currentPolicyVersion;
    if (!policyCompatible) {
      reasons.push(
        `权限策略版本不匹配：检查点=${checkpoint.policyVersion}，当前=${this.options.currentPolicyVersion}，需重新审批`,
      );
    }

    // 3. 幂等性校验（已完成步骤的幂等键非空）
    const idempotencyValid = checkpoint.idempotencyKeys.length > 0 || checkpoint.completedSteps.length === 0;
    if (!idempotencyValid) {
      reasons.push('已完成步骤缺少幂等键记录，无法安全跳过');
    }

    const safe = envCompatible.compatible && policyCompatible && idempotencyValid;

    return {
      safe,
      environmentCompatible: envCompatible.compatible,
      policyCompatible,
      idempotencyValid,
      reasons,
    };
  }

  private verifyEnvironment(
    saved: EnvironmentSnapshot,
    current: EnvironmentSnapshot,
  ): { compatible: boolean; reasons: string[] } {
    const reasons: string[] = [];

    if (saved.os !== current.os) {
      reasons.push(`操作系统不兼容：检查点=${saved.os}，当前=${current.os}`);
    }
    // Node 主版本号必须一致
    const savedMajor = saved.nodeVersion.split('.')[0];
    const currentMajor = current.nodeVersion.split('.')[0];
    if (savedMajor !== currentMajor) {
      reasons.push(`Node 主版本不兼容：检查点=${saved.nodeVersion}，当前=${current.nodeVersion}`);
    }
    if (saved.workspacePath !== current.workspacePath) {
      reasons.push(`工作区路径变化：检查点=${saved.workspacePath}，当前=${current.workspacePath}`);
    }
    // Git commit 变化是允许的（代码可能已更新），但需要记录

    return {
      compatible: reasons.length === 0,
      reasons,
    };
  }
}
