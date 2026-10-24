/**
 * WorkspaceManager：工作区管理器（v0.4.0 Phase 2）。
 *
 * 职责：
 *   - 创建隔离工作区（优先 Git Worktree，回退临时目录）；
 *   - 获取工作区路径；
 *   - 清理工作区。
 *
 * 安全约束：
 *   - 所有路径通过 WorkspaceGuard 校验；
 *   - Git Worktree 只做代码隔离，不替代 OS 级沙箱；
 *   - 工作区必须在授权根目录内。
 */
import type { WorkspaceGuard } from '@forgex/security';
import type { Sandbox, SandboxSpec } from '../types.js';
import { GitWorktreeProvider } from '../providers/git-worktree-provider.js';
import { TempDirProvider } from '../providers/temp-dir-provider.js';

export class WorkspaceManager {
  private readonly gitWorktreeProvider: GitWorktreeProvider;
  private readonly tempDirProvider: TempDirProvider;

  constructor(workspaceGuard: WorkspaceGuard) {
    this.gitWorktreeProvider = new GitWorktreeProvider(workspaceGuard);
    this.tempDirProvider = new TempDirProvider();
  }

  /**
   * 创建隔离工作区。
   * 优先 Git Worktree（如果 Git 可用且需要），否则临时目录。
   */
  async createWorkspace(spec: SandboxSpec): Promise<Sandbox> {
    if (spec.needGitWorktree) {
      const gitAvailable = await this.gitWorktreeProvider.isAvailable();
      if (gitAvailable) {
        return this.gitWorktreeProvider.create(spec);
      }
      // Git 不可用，回退到临时目录
    }

    return this.tempDirProvider.create(spec);
  }

  /** 清理工作区 */
  async destroyWorkspace(sandbox: Sandbox): Promise<void> {
    if (sandbox.type === 'git_worktree') {
      await this.gitWorktreeProvider.destroy(sandbox);
    } else {
      await this.tempDirProvider.destroy(sandbox);
    }
  }

  /** 获取 GitWorktreeProvider（供外部检查可用性） */
  getGitWorktreeProvider(): GitWorktreeProvider {
    return this.gitWorktreeProvider;
  }

  /** 获取 TempDirProvider */
  getTempDirProvider(): TempDirProvider {
    return this.tempDirProvider;
  }
}
