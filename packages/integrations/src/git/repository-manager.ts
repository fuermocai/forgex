/**
 * RepositoryManager：仓库状态管理（v0.4.0 Phase 4）。
 *
 * 职责：
 *   - 受保护分支检测；
 *   - 仓库状态查询；
 *   - 远程配置（只读）。
 *
 * 安全约束：
 *   - 禁止合并到受保护分支；
 *   - 禁止修改仓库权限或 CI 凭据。
 */
import { ForgeError } from '@forgex/shared';
import type { BranchInfo } from '../types.js';
import { PROTECTED_BRANCH_NAMES, PROTECTED_BRANCH_REGEXES } from '../types.js';
import { GitService } from './git-service.js';

export class RepositoryManager {
  private readonly gitService: GitService;

  constructor(gitService: GitService) {
    this.gitService = gitService;
  }

  /** 判断分支是否受保护 */
  isProtectedBranch(branchName: string): boolean {
    if (PROTECTED_BRANCH_NAMES.includes(branchName)) return true;
    return PROTECTED_BRANCH_REGEXES.some((re) => re.test(branchName));
  }

  /** 获取所有分支并标记受保护状态 */
  async getBranches(): Promise<BranchInfo[]> {
    const branches = await this.gitService.listBranches();
    return branches.map((b) => ({
      ...b,
      protected: this.isProtectedBranch(b.name),
    }));
  }

  /** 获取当前分支 */
  async getCurrentBranch(): Promise<BranchInfo | null> {
    const branches = await this.getBranches();
    return branches.find((b) => b.current) ?? null;
  }

  /**
   * 检查是否可以合并到目标分支。
   * 受保护分支禁止合并。
   */
  canMergeTo(targetBranch: string): { allowed: boolean; reason?: string } {
    if (this.isProtectedBranch(targetBranch)) {
      return {
        allowed: false,
        reason: `分支 ${targetBranch} 是受保护分支，禁止自动合并`,
      };
    }
    return { allowed: true };
  }

  /**
   * 尝试合并到目标分支。
   * 受保护分支抛错。
   */
  async mergeTo(targetBranch: string): Promise<void> {
    const check = this.canMergeTo(targetBranch);
    if (!check.allowed) {
      throw new ForgeError('POLICY_DENIED', check.reason ?? '禁止合并到受保护分支');
    }
    // 实际合并逻辑（第一版不实现自动合并，只做检查）
    throw new ForgeError(
      'POLICY_DENIED',
      '自动合并功能未启用，请手动执行合并操作',
    );
  }
}
